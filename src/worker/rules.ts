// SQL-level validation rules (spec §5.5) — the authoritative service layer.
// All queries are user-scoped (WHERE user_id = ?) per NFR-3.

import type { Env } from './env';

export class RuleError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Detect SQLite unique-constraint violations from a D1 error.
 * D1 does not expose structured SQLite codes, so match on the standard
 * message text plus the driver error code when present.
 */
export function isUniqueConstraintError(e: unknown): boolean {
  const err = e as { message?: string; code?: string | number } | null;
  if (!err) return false;
  if (typeof err.code === 'number' && err.code === 2067) return true; // SQLITE_CONSTRAINT_UNIQUE
  return /UNIQUE constraint failed/i.test(String(err.message ?? ''));
}

// ---------- hierarchy (FR-T3, FR-T1) ----------

export interface TaskRow {
  id: string;
  user_id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  notes: string;
  done: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export async function getTaskOwned(env: Env, userId: string, taskId: string): Promise<TaskRow> {
  const t = await env.DB.prepare(
    `SELECT id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at
     FROM tasks WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(taskId, userId)
    .first<TaskRow>();
  if (!t) throw new RuleError(404, 'not_found', 'task not found');
  return t;
}

/** Subtask creation requires a ROOT-task parent ("a subtask can't have subtasks", FR-T3). */
export async function requireRootTaskForSubtask(env: Env, userId: string, taskId: string) {
  const task = await getTaskOwned(env, userId, taskId);
  if (task.parent_id !== null) {
    throw new RuleError(422, 'two_level_hierarchy', "a subtask can't have subtasks");
  }
  return task;
}

/** Distinguish "id is a subtask" (→ hierarchy error) from "unknown id" (→ 404).
 *  Id-only on purpose: group-project subtasks carry their creator's user_id,
 *  and the caller's project-access check authorizes the actual operation. */
export async function assertNotSubtask(env: Env, id: string): Promise<void> {
  const sub = await env.DB.prepare('SELECT 1 FROM subtasks WHERE id = ?1').bind(id).first();
  if (sub) throw new RuleError(422, 'two_level_hierarchy', "a subtask can't have subtasks");
}

// ---------- dependencies (FR-M4/M5) ----------

async function getTaskFull(
  env: Env,
  taskId: string,
  scopeUserId: string | null,
): Promise<{ id: string; project_id: string; parent_id: string | null; name: string }> {
  const t = await env.DB.prepare(
    `SELECT id, project_id, parent_id, name FROM tasks WHERE id = ?1 ${scopeUserId ? 'AND user_id = ?2' : ''}`,
  )
    .bind(...(scopeUserId ? [taskId, scopeUserId] : [taskId]))
    .first<{ id: string; project_id: string; parent_id: string | null; name: string }>();
  if (!t) throw new RuleError(404, 'not_found', 'task not found');
  return t;
}

/**
 * Validate + insert an edge "taskId depends on dependsOnId":
 * same project, root tasks only, no self/duplicate, and cycle-free —
 * the cycle check is a recursive CTE reachability query (§5.5.1) and the
 * offending path is returned for the UI toast ("A → B → C → A").
 *
 * `scopeUserId` narrows the dependency graph to one user's edges (personal
 * projects); pass null for GROUP projects — edges there may be created by any
 * member, so cycle detection must see the whole project's graph.
 */
export async function createDependency(
  env: Env,
  userId: string,
  taskId: string,
  dependsOnId: string,
  scopeUserId: string | null = userId,
) {
  if (taskId === dependsOnId) throw new RuleError(422, 'self_dependency', "a task can't depend on itself");
  const [a, b] = await Promise.all([getTaskFull(env, taskId, scopeUserId), getTaskFull(env, dependsOnId, scopeUserId)]);
  if (a.parent_id !== null || b.parent_id !== null)
    throw new RuleError(422, 'edge_endpoints', 'dependencies may only connect root tasks');
  if (a.project_id !== b.project_id)
    throw new RuleError(422, 'cross_project_edge', 'dependencies may only connect tasks of the same project');

  const dup = await env.DB.prepare(`SELECT 1 FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2`)
    .bind(taskId, dependsOnId)
    .first();
  if (dup) throw new RuleError(422, 'duplicate_edge', 'this dependency already exists');

  // Reachability: edge "taskId depends on dependsOnId" is illegal when taskId is
  // reachable from dependsOnId by following depends_on edges (that closes the loop).
  const reach = await env.DB.prepare(
    `WITH REACH(id) AS (
       SELECT ?1
       UNION
       SELECT td.depends_on_id FROM task_dependencies td
       JOIN REACH r ON td.task_id = r.id
       ${scopeUserId ? 'WHERE td.user_id = ?2' : ''}
     )
     SELECT id FROM REACH WHERE id = ?3`,
  )
    .bind(...(scopeUserId ? [dependsOnId, scopeUserId] : [dependsOnId]), taskId)
    .first();
  if (reach) {
    const path = await cyclePathNames(env, taskId, dependsOnId, scopeUserId);
    throw new RuleError(422, 'cycle', `this would create a circular dependency: ${path.join(' → ')}`, { path });
  }

  await env.DB.prepare(
    `INSERT INTO task_dependencies (task_id, depends_on_id, user_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(taskId, dependsOnId, userId, Date.now())
    .run();
  return { task_id: taskId, depends_on_id: dependsOnId };
}

/** Reconstruct the would-be cycle path with task names for the toast (FR-M4 AC). */
async function cyclePathNames(
  env: Env,
  taskId: string,
  dependsOnId: string,
  scopeUserId: string | null,
): Promise<string[]> {
  // chain from target following depends_on edges: [target, …, source]
  const rows = await env.DB.prepare(
    `WITH REACH(id, depth) AS (
       SELECT ?1, 0
       UNION
       SELECT td.depends_on_id, r.depth + 1 FROM task_dependencies td
       JOIN REACH r ON td.task_id = r.id
       WHERE ${scopeUserId ? 'td.user_id = ?2 AND' : ''} r.depth < 50
     )
     SELECT id FROM REACH ORDER BY depth`,
  )
    .bind(...(scopeUserId ? [dependsOnId, scopeUserId] : [dependsOnId]))
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);
  // full loop display: source → target → … → source
  // (ids already ends at the source — drop it before closing the loop)
  const loop = [taskId, ...ids.slice(0, Math.max(0, ids.length - 1)), taskId];
  const names: string[] = [];
  for (const id of loop) {
    const t = await env.DB.prepare('SELECT name FROM tasks WHERE id = ?1').bind(id).first<{ name: string }>();
    names.push(t?.name ?? id.slice(0, 6));
  }
  return names;
}

/** Re-parenting a task must not strand cross-project dependencies (FR-T1).
 *  scopeUserId = null widens to the whole project's edges (group projects). */
export async function assertReparentSafe(
  env: Env,
  userId: string,
  taskId: string,
  targetProjectId: string,
  scopeUserId: string | null = userId,
) {
  const bad = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM task_dependencies td
     JOIN tasks other ON other.id = CASE WHEN td.task_id = ?1 THEN td.depends_on_id ELSE td.task_id END
     WHERE (td.task_id = ?1 OR td.depends_on_id = ?1)
       ${scopeUserId ? 'AND td.user_id = ?2' : ''}
       AND other.project_id <> ?3`,
  )
    .bind(...(scopeUserId ? [taskId, scopeUserId] : [taskId]), targetProjectId)
    .first<{ n: number }>();
  if (Number(bad?.n ?? 0) > 0) {
    throw new RuleError(422, 'cross_project_dep', 'cannot move this task: it has dependencies in another project');
  }
}

// ---------- limits (NFR-2) ----------

async function countOne(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  const r = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export async function assertProjectLimit(env: Env, userId: string) {
  const n = await countOne(env, 'SELECT COUNT(*) AS n FROM projects WHERE user_id = ?1 AND archived = 0', userId);
  if (n >= 200) throw new RuleError(422, 'limit', 'limit reached: at most 200 active projects per account');
}

export async function assertTaskLimit(env: Env, userId: string) {
  const n = await countOne(env, 'SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?1', userId);
  if (n >= 5000) throw new RuleError(422, 'limit', 'limit reached: at most 5000 tasks per account');
}

export async function assertSubtaskLimit(env: Env, userId: string, taskId: string) {
  const n = await countOne(
    env,
    'SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?1 AND user_id = ?2',
    taskId,
    userId,
  );
  if (n >= 100) throw new RuleError(422, 'limit', 'limit reached: at most 100 subtasks per task');
}

// ---------- sessions (FR-S4/S6) ----------

/** Same-task overlap query; a running session occupies until `now`. Returns conflicting rows. */
export async function findSameTaskOverlaps(
  env: Env,
  userId: string,
  taskId: string,
  start: number,
  end: number,
  now: number,
  excludeId?: string,
) {
  const sql = `
    SELECT id, started_at, ended_at FROM time_sessions
    WHERE task_id = ?1 AND user_id = ?2
      AND started_at < ?3 AND COALESCE(ended_at, ?4) > ?5
      ${excludeId ? 'AND id <> ?6' : ''}`;
  const stmt = excludeId
    ? env.DB.prepare(sql).bind(taskId, userId, end, now, start, excludeId)
    : env.DB.prepare(sql).bind(taskId, userId, end, now, start);
  const r = await stmt.all<any>();
  return r.results;
}

export function conflictError(rows: { id: string; started_at: number; ended_at: number | null }[]) {
  return new RuleError(409, 'overlap', 'this session overlaps an existing session on the same task', rows);
}

/** The running session may not be edited/deleted — stop or switch first (FR-S6). */
export async function assertNotRunning(env: Env, userId: string, sessionId: string) {
  const r = await env.DB.prepare('SELECT 1 FROM time_sessions WHERE id = ?1 AND user_id = ?2 AND ended_at IS NULL')
    .bind(sessionId, userId)
    .first();
  if (r) throw new RuleError(409, 'running_session', 'the running session cannot be edited — stop or switch first');
}
