// FR-S: manual session entry (validated), session log (filterable, paginated),
// session edit/delete with undo payload. The running session is protected (FR-S6).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth } from '../middleware';
import { sessionCreateSchema, sessionPatchSchema } from '../validators';
import { checkSessionTimes, findOverlaps, noteProblem, nameProblem } from '../../shared/validation';
import { findSameTaskOverlaps, conflictError, assertNotRunning, RuleError } from '../rules';
import { appendEvents, notifyHub, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { LIMITS } from '../../shared/constants';

export const sessionRoutes = new Hono<WorkerType>();
sessionRoutes.use('/sessions', requireAuth);
sessionRoutes.use('/sessions/*', requireAuth);

const LIST_LIMIT = LIMITS.logPageSize;

/** Escape SQL LIKE wildcards so user input matches literally. */
function escapeLike(input: string): string {
  return `%${input.replace(/[\\%_]/g, '\\$&')}%`;
}

sessionRoutes.get('/sessions', async (c) => {
  const userId = c.get('user').id;
  const projectId = c.req.query('project_id');
  const taskId = c.req.query('task_id');
  const from = c.req.query('from') ? Number(c.req.query('from')) : null;
  const to = c.req.query('to') ? Number(c.req.query('to')) : null;
  const note = c.req.query('q');
  const cursor = c.req.query('cursor'); // "<started_at>_<id>"

  const where: string[] = ['s.user_id = ?1'];
  const binds: unknown[] = [userId];
  let n = 1;
  if (taskId) { where.push(`s.task_id = ?${++n}`); binds.push(taskId); }
  if (projectId) { where.push(`t.project_id = ?${++n}`); binds.push(projectId); }
  // running rows (ended_at IS NULL) have no end — the "from" floor never excludes them
  if (from !== null) { where.push(`(s.ended_at IS NULL OR s.ended_at >= ?${++n})`); binds.push(from); }
  if (to !== null) { where.push(`s.started_at < ?${++n}`); binds.push(to); }
  if (note) { where.push(`s.note LIKE ?${++n} ESCAPE '\\'`); binds.push(escapeLike(note)); }
  if (cursor) {
    const [sa, id] = cursor.split('_');
    where.push(`(s.started_at < ?${++n} OR (s.started_at = ?${n} AND s.id < ?${++n}))`);
    binds.push(Number(sa), id);
  }

  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.task_id, s.started_at, s.ended_at, s.source, s.note,
            t.name AS task_name, t.project_id, p.name AS project_name, p.color AS project_color
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.started_at DESC, s.id DESC
     LIMIT ?${++n}`
  ).bind(...binds, LIST_LIMIT + 1).all<any>();

  const hasMore = rows.results.length > LIST_LIMIT;
  const results = hasMore ? rows.results.slice(0, LIST_LIMIT) : rows.results;
  const last = results[results.length - 1];
  return c.json({
    sessions: results,
    next_cursor: hasMore && last ? `${last.started_at}_${last.id}` : null
  });
});

sessionRoutes.post('/sessions', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const parsed = sessionCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid session payload', parsed.error.flatten());
  const { task_id, started_at, ended_at, note } = parsed.data;

  const task = await c.env.DB.prepare(
    `SELECT t.id, t.project_id, t.name, p.archived FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?1 AND t.user_id = ?2`
  ).bind(task_id, userId).first<any>();
  if (!task) return jsonError(404, 'not_found', 'task not found');
  if (task.archived) return jsonError(422, 'archived', 'this project is archived — new sessions are blocked on it');

  const now = Date.now();
  const timeCheck = checkSessionTimes(started_at, ended_at, user.created_at, now);
  if (!timeCheck.ok) return jsonError(422, 'validation', timeCheck.problem!);
  const nErr = noteProblem(note);
  if (nErr) return jsonError(422, 'validation', nErr);

  // same-task overlap rejected; conflicts returned so the UI can highlight them (FR-S4 AC)
  const conflicts = await findSameTaskOverlaps(c.env, userId, task_id, started_at, ended_at, now);
  if (conflicts.length > 0) return new Response(JSON.stringify({
    error: { code: 'overlap', message: 'this session overlaps an existing session on the same task', details: conflicts }
  }), { status: 409, headers: { 'content-type': 'application/json' } });

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM time_sessions WHERE user_id = ?1')
    .bind(userId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= LIMITS.sessionsPerUser)
    return jsonError(422, 'limit', 'limit reached: at most 200000 sessions per account');

  const id = ulid(now);
  await c.env.DB.prepare(
    `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'manual', ?6, ?7, ?7)`
  ).bind(id, userId, task_id, started_at, ended_at, note, now).run();

  const session = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1').bind(id).first();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'session.created', actor: c.get('deviceId'), data: { session } }] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ session, events: evs }, 201);
});

sessionRoutes.patch('/sessions/:id', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const existing = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!existing) return jsonError(404, 'not_found', 'session not found');
  await assertNotRunning(c.env, userId, existing.id); // FR-S6: stop or switch first

  const parsed = sessionPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid session payload', parsed.error.flatten());
  const u = parsed.data;
  const taskId = u.task_id ?? existing.task_id;
  const started = u.started_at ?? existing.started_at;
  const ended = u.ended_at !== undefined ? u.ended_at : existing.ended_at;
  const note = u.note ?? existing.note;

  const task = await c.env.DB.prepare('SELECT id FROM tasks WHERE id = ?1 AND user_id = ?2')
    .bind(taskId, userId).first();
  if (!task) return jsonError(404, 'not_found', 'task not found');
  const now = Date.now();
  const timeCheck = checkSessionTimes(started, ended, user.created_at, now);
  if (!timeCheck.ok) return jsonError(422, 'validation', timeCheck.problem!);
  const nErr = noteProblem(note);
  if (nErr) return jsonError(422, 'validation', nErr);

  const conflicts = await findSameTaskOverlaps(c.env, userId, taskId, started, ended, now, existing.id);
  if (conflicts.length > 0) throw conflictError(conflicts);

  await c.env.DB.prepare(
    `UPDATE time_sessions SET task_id = ?1, started_at = ?2, ended_at = ?3, note = ?4, source = 'manual', updated_at = ?5
     WHERE id = ?6 AND user_id = ?7`
  ).bind(taskId, started, ended, note, now, existing.id, userId).run();

  const session = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1').bind(existing.id).first();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'session.updated', actor: c.get('deviceId'), data: { session } }] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ session, events: evs });
});

sessionRoutes.delete('/sessions/:id', async (c) => {
  const userId = c.get('user').id;
  const existing = await c.env.DB.prepare('SELECT * FROM time_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!existing) return jsonError(404, 'not_found', 'session not found');
  await assertNotRunning(c.env, userId, existing.id);
  await c.env.DB.prepare('DELETE FROM time_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(existing.id, userId).run();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'session.deleted', actor: c.get('deviceId'), data: { session: existing } }] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ deleted: true, undo: { sessions: [existing] }, events: evs });
});
