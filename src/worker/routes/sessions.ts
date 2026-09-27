// FR-S: manual session entry (validated), session log (filterable, paginated),
// session edit/delete with undo payload. The running session is protected (FR-S6).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitWrites } from '../middleware';
import { sessionCreateSchema, sessionPatchSchema } from '../validators';
import { checkSessionTimes, noteProblem } from '../../shared/validation';
import {
  findSameTaskOverlaps,
  insertSessionGuarded,
  updateSessionGuarded,
  conflictError,
  assertNotRunning,
} from '../rules';
import { appendEvents, notifyHub, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { LIMITS } from '../../shared/constants';

export const sessionRoutes = new Hono<WorkerType>();
sessionRoutes.use('/sessions', requireAuth, limitWrites);
sessionRoutes.use('/sessions/*', requireAuth, limitWrites);

const LIST_LIMIT = LIMITS.logPageSize;

/** Escape SQL LIKE wildcards so user input matches literally. */
function escapeLike(input: string): string {
  return `%${input.replace(/[\\%_]/g, '\\$&')}%`;
}

sessionRoutes.get('/sessions', async (c) => {
  const userId = c.get('user').id;
  const projectId = c.req.query('project_id');
  const taskId = c.req.query('task_id');
  // audit: NaN filters used to be silently ignored (or 500'd into D1 binds) —
  // validate like /sync does
  const toInstant = (raw: string | undefined): number | null | undefined => {
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined; // undefined = invalid → 422
    return n;
  };
  const from = toInstant(c.req.query('from'));
  const to = toInstant(c.req.query('to'));
  if (from === undefined || to === undefined)
    return jsonError(422, 'validation', 'from/to must be non-negative epoch-ms integers');
  const note = c.req.query('q');
  // page-based pagination: 1-based page + clamped page size
  const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? 1)) || 1);
  const pageSize = Math.min(
    LIST_LIMIT,
    Math.max(1, Math.floor(Number(c.req.query('page_size') ?? LIST_LIMIT)) || LIST_LIMIT),
  );

  const where: string[] = ['s.user_id = ?1'];
  const binds: unknown[] = [userId];
  let n = 1;
  if (taskId) {
    where.push(`s.task_id = ?${++n}`);
    binds.push(taskId);
  }
  if (projectId) {
    where.push(`t.project_id = ?${++n}`);
    binds.push(projectId);
  }
  // running rows (ended_at IS NULL) have no end — the "from" floor never excludes them
  if (from !== null) {
    where.push(`(s.ended_at IS NULL OR s.ended_at >= ?${++n})`);
    binds.push(from);
  }
  if (to !== null) {
    where.push(`s.started_at < ?${++n}`);
    binds.push(to);
  }
  if (note) {
    where.push(`s.note LIKE ?${++n} ESCAPE '\\'`);
    binds.push(escapeLike(note));
  }

  const whereSql = where.join(' AND ');
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE ${whereSql}`,
  )
    .bind(...binds)
    .first<{ n: number }>();
  const total = Number(totalRow?.n ?? 0);

  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.task_id, s.started_at, s.ended_at, s.source, s.note, s.subtask_id,
            t.name AS task_name, sb.name AS subtask_name, t.project_id, p.name AS project_name, p.color AS project_color
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     LEFT JOIN subtasks sb ON sb.id = s.subtask_id
     JOIN projects p ON p.id = t.project_id
     WHERE ${whereSql}
     ORDER BY s.started_at DESC, s.id DESC
     LIMIT ?${++n} OFFSET ?${++n}`,
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all<any>();

  return c.json({
    sessions: rows.results,
    total,
    page,
    page_size: pageSize,
  });
});

sessionRoutes.post('/sessions', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const parsed = sessionCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid session payload', parsed.error.flatten());
  const { task_id, subtask_id, started_at, ended_at, note } = parsed.data;

  const task = await c.env.DB.prepare(
    `SELECT t.id, t.project_id, t.name, p.archived FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?1 AND (t.user_id = ?2 OR p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?2))`,
  )
    .bind(task_id, userId)
    .first<any>();
  if (!task) return jsonError(404, 'not_found', 'task not found');
  if (task.archived) return jsonError(422, 'archived', 'this project is archived — new sessions are blocked on it');
  if (subtask_id) {
    // the subtask must belong to the session's task (task scope already checked)
    const sub = await c.env.DB.prepare('SELECT id FROM subtasks WHERE id = ?1 AND task_id = ?2')
      .bind(subtask_id, task_id)
      .first();
    if (!sub) return jsonError(422, 'invalid_subtask', 'the subtask does not belong to this task');
  }

  const now = Date.now();
  const timeCheck = checkSessionTimes(started_at, ended_at, user.created_at, now);
  if (!timeCheck.ok) return jsonError(422, 'validation', timeCheck.problem!);
  const nErr = noteProblem(note);
  if (nErr) return jsonError(422, 'validation', nErr);

  // Same-task overlap rejected; conflicts returned so the UI can highlight them
  // (FR-S4 AC). This query only builds the 409 BODY — the insert below is the
  // authoritative check, with the overlap predicate and the session cap inside
  // the statement, because check-then-insert loses concurrent requests (INV-03).
  const conflicts = await findSameTaskOverlaps(c.env, userId, task_id, started_at, ended_at, now);
  if (conflicts.length > 0) throw conflictError(conflicts); // formatted by app.onError

  const id = ulid(now);
  const written = await insertSessionGuarded(c.env, {
    id,
    userId,
    taskId: task_id,
    subtaskId: subtask_id ?? null,
    startedAt: started_at,
    endedAt: ended_at,
    note,
    now,
    cap: LIMITS.sessionsPerUser,
  });
  if (!written.ok) {
    // A concurrent request got there first. Re-read to report the right error:
    // the overlap wins if it now conflicts, otherwise it is the account cap.
    const raced = await findSameTaskOverlaps(c.env, userId, task_id, started_at, ended_at, now);
    if (raced.length > 0) throw conflictError(raced);
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.sessionsPerUser} sessions per account`);
  }

  const session = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1').bind(id).first();
  const evs = await appendEvents(c.env, userId, [
    { type: 'session.created', actor: c.get('deviceId'), data: { session } },
  ] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ session, events: evs }, 201);
});

sessionRoutes.patch('/sessions/:id', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const existing = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId)
    .first<any>();
  if (!existing) return jsonError(404, 'not_found', 'session not found');
  await assertNotRunning(c.env, userId, existing.id); // FR-S6: stop or switch first

  const parsed = sessionPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid session payload', parsed.error.flatten());
  const u = parsed.data;
  const taskId = u.task_id ?? existing.task_id;
  const started = u.started_at ?? existing.started_at;
  const ended = u.ended_at !== undefined ? u.ended_at : existing.ended_at;
  const note = u.note ?? existing.note;
  // subtask link: explicitly clearable (null) or must belong to the (possibly new) task
  const subtaskId = u.subtask_id !== undefined ? (u.subtask_id ?? null) : (existing.subtask_id ?? null);

  const task = await c.env.DB.prepare(
    `SELECT t.id FROM tasks t WHERE t.id = ?1
       AND (t.user_id = ?2 OR t.project_id IN (SELECT id FROM projects WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?2)))`,
  )
    .bind(taskId, userId)
    .first();
  if (!task) return jsonError(404, 'not_found', 'task not found');
  if (subtaskId) {
    const sub = await c.env.DB.prepare('SELECT id FROM subtasks WHERE id = ?1 AND task_id = ?2')
      .bind(subtaskId, taskId)
      .first();
    if (!sub) return jsonError(422, 'invalid_subtask', 'the subtask does not belong to this task');
  }
  const now = Date.now();
  const timeCheck = checkSessionTimes(started, ended, user.created_at, now);
  if (!timeCheck.ok) return jsonError(422, 'validation', timeCheck.problem!);
  const nErr = noteProblem(note);
  if (nErr) return jsonError(422, 'validation', nErr);

  const conflicts = await findSameTaskOverlaps(c.env, userId, taskId, started, ended, now, existing.id);
  if (conflicts.length > 0) throw conflictError(conflicts);

  // Same shape as the insert: the pre-check above only builds the 409 body, the
  // guarded statement decides (the PATCH path had the same check-then-write
  // race, from two devices editing one session into overlapping windows).
  const written = await updateSessionGuarded(c.env, {
    id: existing.id,
    userId,
    taskId,
    subtaskId,
    startedAt: started,
    endedAt: ended,
    note,
    now,
  });
  if (!written.ok) {
    // either a concurrent request created an overlap, or the row was deleted
    // while we were validating it
    const still = await c.env.DB.prepare('SELECT 1 FROM time_sessions WHERE id = ?1 AND user_id = ?2')
      .bind(existing.id, userId)
      .first();
    if (!still) return jsonError(404, 'not_found', 'session not found');
    const raced = await findSameTaskOverlaps(c.env, userId, taskId, started, ended, now, existing.id);
    throw conflictError(raced);
  }

  const session = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1').bind(existing.id).first();
  const evs = await appendEvents(c.env, userId, [
    { type: 'session.updated', actor: c.get('deviceId'), data: { session } },
  ] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ session, events: evs });
});

sessionRoutes.delete('/sessions/:id', async (c) => {
  const userId = c.get('user').id;
  const existing = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId)
    .first<any>();
  if (!existing) return jsonError(404, 'not_found', 'session not found');
  await assertNotRunning(c.env, userId, existing.id);
  await c.env.DB.prepare('DELETE FROM time_sessions WHERE id = ?1 AND user_id = ?2').bind(existing.id, userId).run();
  const evs = await appendEvents(c.env, userId, [
    { type: 'session.deleted', actor: c.get('deviceId'), data: { session: existing } },
  ] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ deleted: true, undo: { sessions: [existing] }, events: evs });
});
