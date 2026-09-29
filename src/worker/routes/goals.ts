// Goals (v0.6.0): user-owned CRUD + progress. Status is DERIVED (shared/goals.ts
// goalStatus) from archived_at / ends_at / the live done-states of the scope
// refs — nothing materializes completion, so un-checking a scope item
// re-activates a completed goal. Progress follows the reports pattern: period
// windows are built by shared/goals.ts and fed to SQL via json_each(); clients
// get buckets, never raw session rows. The running session is included, clipped
// to `now` (FR-R6 parity with reports).
//
// Scope refs may point at group-project nodes the user can track (their
// sessions stay user-owned); accessibility uses the same predicates as
// bootstrap. The per-user cap is enforced INSIDE the INSERT (audit 🟡2).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import type { Env } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy, limitWrites } from '../middleware';
import { goalCreateSchema, goalPatchSchema } from '../validators';
import { commitWithEvents } from '../events';
import { RuleError } from '../rules';
import { parseScope, scopeKinds, goalWindows, goalStats, goalStatus, scopeIsEmpty } from '../../shared/goals';
import type { Goal, GoalScopeKind } from '../../shared/goals';
import { LIMITS } from '../../shared/constants';
import { ulid } from '../../shared/ids';

export const goalRoutes = new Hono<WorkerType>();
goalRoutes.use('/goals', requireAuth, limitWrites);
goalRoutes.use('/goals/*', requireAuth, limitWrites);

// Accessibility predicates — a node is in scope for the user when they own it
// or it lives in one of their group projects (mirrors /bootstrap's queries).
const accProject = (p: string, u: number) =>
  `(${p}.user_id = ?${u} OR ${p}.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?${u}))`;
const accTask = (p: string, u: number) =>
  `(${p}.user_id = ?${u} OR ${p}.project_id IN (SELECT id FROM projects WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?${u})))`;

const GOAL_COLS = 'id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at';

function rowToGoal(r: any): Goal {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    period: r.period,
    direction: r.direction,
    target_minutes: r.target_minutes,
    scope: parseScope(JSON.parse(r.scope)),
    ends_at: r.ends_at ?? null,
    created_at: r.created_at,
    archived_at: r.archived_at ?? null,
  };
}

/** Every scope ref must resolve to a live, accessible node — RuleError otherwise. */
async function assertScopeAccessible(env: Env, userId: string, scope: string[]): Promise<void> {
  const kinds = scopeKinds({ scope });
  const checks: Array<{ table: string; ids: string[]; kind: GoalScopeKind }> = [
    { table: 'projects', ids: kinds.projects, kind: 'project' },
    { table: 'tasks', ids: kinds.tasks, kind: 'task' },
    { table: 'subtasks', ids: kinds.subtasks, kind: 'subtask' },
  ];
  for (const chk of checks) {
    if (chk.ids.length === 0) continue;
    // ?1..?N = the id list, ?N+1 = the user (referenced repeatedly by the
    // accessibility predicate) — explicit numbering keeps >1-id lists honest
    const marks = chk.ids.map((_, i) => `?${i + 1}`).join(',');
    const u = chk.ids.length + 1;
    let live: string;
    if (chk.kind === 'project') live = `id IN (${marks}) AND deleted_at IS NULL AND ${accProject('projects', u)}`;
    else if (chk.kind === 'task') live = `id IN (${marks}) AND deleted_at IS NULL AND ${accTask('tasks', u)}`;
    else
      // a subtask of a tombstoned task is unreachable for live paths (INV-06)
      live = `id IN (${marks}) AND (user_id = ?${u} OR task_id IN (SELECT id FROM tasks WHERE deleted_at IS NULL AND ${accTask('tasks', u)}))`;
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${chk.table} WHERE ${live}`)
      .bind(...chk.ids, userId)
      .first<{ n: number }>();
    if (Number(r?.n ?? 0) < chk.ids.length)
      throw new RuleError(422, 'scope_ref', `goal scope references an unknown or inaccessible ${chk.kind}`);
  }
}

/** The guarded per-user-cap INSERT — decides the cap inside the write itself. */
function insertStmt(env: Env, g: Goal) {
  return env.DB.prepare(
    `INSERT INTO goals (id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE (SELECT COUNT(*) FROM goals WHERE user_id = ?2) < ?10`,
  ).bind(
    g.id,
    g.user_id,
    g.name,
    g.period,
    g.direction,
    g.target_minutes,
    JSON.stringify(g.scope),
    g.ends_at,
    g.created_at,
    LIMITS.goalsPerUser,
  );
}

// ---------- progress ----------

goalRoutes.get('/goals/progress', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const user = c.get('user');
  const now = Date.now();

  const qWindows = Number(c.req.query('windows') ?? 12);
  const detail = Number.isInteger(qWindows) && qWindows > 0 ? Math.min(qWindows, 60) : 12;

  const rows = await c.env.DB.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE user_id = ?1 ORDER BY created_at`)
    .bind(userId)
    .all<any>();
  const goals = rows.results.map(rowToGoal);

  // Two batched statements per goal: (a) tracked ms per window, (b) the scope's
  // live/done counts for the derived status. One round trip for all goals.
  const stmts: D1PreparedStatement[] = [];
  for (const g of goals) {
    const kinds = scopeKinds(g);
    const windows = goalWindows(g, user.timezone, user.week_start, now);
    // span the caller counts per window: clipped to the goal's lifetime at both
    // ends (created_at / expiry / archive) and to `now` for the running session
    const horizon = Math.min(g.ends_at ?? Infinity, g.archived_at ?? Infinity, now);
    const spans = windows.map((w, i) => [i, Math.max(w.start, g.created_at), Math.min(w.end, horizon)]);

    // (a) — scope predicate: one session matches at most once (WHERE-OR, not UNION)
    const ors: string[] = [];
    const binds: unknown[] = [];
    let p = 3; // ?1 windows json, ?2 now, ?3 user_id
    for (const [col, ids] of [
      ['t.project_id', kinds.projects],
      ['s.task_id', kinds.tasks],
      ['s.subtask_id', kinds.subtasks],
    ] as Array<[string, string[]]>) {
      if (ids.length === 0) continue;
      ors.push(`${col} IN (${ids.map(() => `?${++p}`).join(',')})`);
      binds.push(...ids);
    }
    stmts.push(
      c.env.DB.prepare(
        `WITH windows(idx, ws, we) AS (
           SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'), json_extract(je.value, '$[2]')
           FROM json_each(?1) AS je
         )
         SELECT w.idx AS idx,
                SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), w.we) - MAX(s.started_at, w.ws))) AS ms
         FROM time_sessions s
         LEFT JOIN tasks t ON t.id = s.task_id
         JOIN windows w ON s.started_at < w.we AND COALESCE(s.ended_at, ?2) > w.ws
         WHERE s.user_id = ?3 AND (${ors.join(' OR ') || '0'})
         GROUP BY w.idx`,
      ).bind(JSON.stringify(spans), now, userId, ...binds),
    );

    // (b) — explicit param numbering: ?1..?n projects, then tasks, then
    // subtasks, then the user (referenced by every accessibility predicate)
    let n = 0;
    const pMarks = kinds.projects.map(() => `?${++n}`).join(',') || 'NULL';
    const tMarks = kinds.tasks.map(() => `?${++n}`).join(',') || 'NULL';
    const sMarks = kinds.subtasks.map(() => `?${++n}`).join(',') || 'NULL';
    const u = ++n;
    const taskCond = `(t.project_id IN (${pMarks}) OR t.id IN (${tMarks}))`;
    const subCond = `sb.id IN (${sMarks})`;
    stmts.push(
      c.env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks t WHERE t.deleted_at IS NULL AND ${accTask('t', u)} AND ${taskCond}) AS live_t,
           (SELECT COALESCE(SUM(t.done), 0) FROM tasks t WHERE t.deleted_at IS NULL AND ${accTask('t', u)} AND ${taskCond}) AS done_t,
           (SELECT COUNT(*) FROM subtasks sb JOIN tasks t2 ON t2.id = sb.task_id
              WHERE t2.deleted_at IS NULL AND ${accTask('t2', u)} AND ${subCond}) AS live_s,
           (SELECT COALESCE(SUM(sb.done), 0) FROM subtasks sb JOIN tasks t2 ON t2.id = sb.task_id
              WHERE t2.deleted_at IS NULL AND ${accTask('t2', u)} AND ${subCond}) AS done_s`,
      ).bind(...kinds.projects, ...kinds.tasks, ...kinds.subtasks, userId),
    );
  }
  const results = stmts.length > 0 ? await c.env.DB.batch(stmts) : [];

  const out = goals.map((g, i) => {
    const windows = goalWindows(g, user.timezone, user.week_start, now);
    const actualRows = results[i * 2]?.results ?? [];
    const byIdx = new Map<number, number>(actualRows.map((r: any) => [Number(r.idx), Number(r.ms ?? 0)]));
    const withActual = windows.map((w, idx) => ({ ...w, actual: Math.round((byIdx.get(idx) ?? 0) / 60_000) }));
    const cnt = (results[i * 2 + 1]?.results?.[0] ?? {}) as any;
    const scope = {
      liveCount: Number(cnt.live_t ?? 0) + Number(cnt.live_s ?? 0),
      doneCount: Number(cnt.done_t ?? 0) + Number(cnt.done_s ?? 0),
    };
    return {
      goal: g,
      status: goalStatus(g, scope, now),
      scope_empty: scopeIsEmpty(scope),
      windows: withActual.slice(-detail),
      stats: goalStats(g, withActual),
    };
  });

  return c.json({ goals: out, server_now: now });
});

// ---------- CRUD ----------

goalRoutes.post('/goals', async (c) => {
  const userId = c.get('user').id;
  const parsed = goalCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid goal payload', parsed.error.flatten());
  const scope = parseScope(parsed.data.scope);
  if (scope.length === 0) return jsonError(422, 'validation', 'goal needs at least one scope item');
  const ends_at = parsed.data.ends_at ?? null;
  // an expiry in the past (beyond a small clock-skew tolerance) is a client bug
  if (ends_at !== null && ends_at <= Date.now() - 60_000)
    return jsonError(422, 'validation', 'ends_at must be in the future');
  await assertScopeAccessible(c.env, userId, scope);

  const goal: Goal = {
    id: ulid(),
    user_id: userId,
    name: parsed.data.name,
    period: parsed.data.period,
    direction: parsed.data.direction,
    target_minutes: parsed.data.target_minutes,
    scope,
    ends_at,
    created_at: Date.now(),
    archived_at: null,
  };
  const res = await insertStmt(c.env, goal).run();
  if (res.meta.changes === 0)
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.goalsPerUser} goals per account`);

  const saved = await c.env.DB.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?1 AND user_id = ?2`)
    .bind(goal.id, userId)
    .first<any>();
  if (!saved) return jsonError(500, 'internal', 'goal vanished after insert');
  const row = rowToGoal(saved);
  const { events } = await commitWithEvents(
    c.env,
    userId,
    [{ type: 'goal.created', actor: c.get('deviceId'), data: { goal: row } }],
    [],
    c.executionCtx,
  );
  return c.json({ goal: row, events }, 201);
});

goalRoutes.patch('/goals/:id', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<any>();
  if (!existing) return jsonError(404, 'not_found', 'goal not found');
  const parsed = goalPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid goal payload', parsed.error.flatten());
  const u = parsed.data;

  let scope: string[] | undefined;
  if (u.scope !== undefined) {
    scope = parseScope(u.scope);
    if (scope.length === 0) return jsonError(422, 'validation', 'goal needs at least one scope item');
    await assertScopeAccessible(c.env, userId, scope);
  }
  let ends_at: number | null | undefined;
  if (u.ends_at !== undefined) {
    ends_at = u.ends_at;
    if (ends_at !== null && ends_at <= existing.created_at)
      return jsonError(422, 'validation', 'ends_at must be after the goal was created');
    if (ends_at !== null && ends_at <= Date.now() - 60_000)
      return jsonError(422, 'validation', 'ends_at must be in the future');
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) {
    sets.push('name = ?');
    binds.push(u.name);
  }
  if (u.period !== undefined) {
    sets.push('period = ?');
    binds.push(u.period);
  }
  if (u.direction !== undefined) {
    sets.push('direction = ?');
    binds.push(u.direction);
  }
  if (u.target_minutes !== undefined) {
    sets.push('target_minutes = ?');
    binds.push(u.target_minutes);
  }
  if (scope !== undefined) {
    sets.push('scope = ?');
    binds.push(JSON.stringify(scope));
  }
  if (ends_at !== undefined) {
    sets.push('ends_at = ?');
    binds.push(ends_at);
  }
  if (u.archived !== undefined) {
    sets.push('archived_at = ?');
    binds.push(u.archived ? Date.now() : null);
  }
  if (sets.length === 0) return jsonError(422, 'validation', 'nothing to update');

  await c.env.DB.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...binds, id, userId)
    .run();

  const saved = await c.env.DB.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<any>();
  if (!saved) return jsonError(404, 'not_found', 'goal not found');
  const row = rowToGoal(saved);
  const { events } = await commitWithEvents(
    c.env,
    userId,
    [{ type: 'goal.updated', actor: c.get('deviceId'), data: { goal: row } }],
    [],
    c.executionCtx,
  );
  return c.json({ goal: row, events });
});

goalRoutes.delete('/goals/:id', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<any>();
  if (!existing) return jsonError(404, 'not_found', 'goal not found');
  // goals are referenced by nothing (tombstones exist for tasks/projects
  // because sessions reference them) — a hard delete is safe; the client's
  // undo re-creates the goal from the returned row
  const row = rowToGoal(existing);
  const { events } = await commitWithEvents(
    c.env,
    userId,
    [{ type: 'goal.deleted', actor: c.get('deviceId'), data: { goal: row } }],
    [c.env.DB.prepare('DELETE FROM goals WHERE id = ?1 AND user_id = ?2').bind(id, userId)],
    c.executionCtx,
  );
  return c.json({ goal: row, events });
});
