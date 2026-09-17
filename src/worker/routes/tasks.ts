// FR-T: tasks, subtask check-lists (two-level, FR-T3), dependency DAG edges
// (cycle-checked, FR-M4). Deleting returns the undo payload (FR-T4).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import type { Context } from 'hono';
import { jsonError } from '../env';
import { requireAuth } from '../middleware';
import { taskCreateSchema, taskPatchSchema, subtaskCreateSchema, subtaskPatchSchema, depCreateSchema } from '../validators';
import {
  assertTaskLimit, assertSubtaskLimit, requireRootTaskForSubtask, assertNotSubtask,
  createDependency, assertReparentSafe, RuleError
} from '../rules';
import { appendEvents, notifyHub, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { findCyclePath } from '../../shared/validation';

export const taskRoutes = new Hono<WorkerType>();
taskRoutes.use('/tasks', requireAuth);
taskRoutes.use('/tasks/*', requireAuth);
taskRoutes.use('/subtasks', requireAuth);
taskRoutes.use('/subtasks/*', requireAuth);
taskRoutes.use('/projects/*', requireAuth);

async function getProjectOwned(c: Context<WorkerType>, id: string) {
  const p = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1 AND user_id = ?2')
    .bind(id, c.get('user').id).first();
  if (!p) throw new RuleError(404, 'not_found', 'project not found');
  return p as any;
}

// ---------- tasks ----------

taskRoutes.get('/projects/:id/tasks', async (c) => {
  const projectId = c.req.param('id');
  await getProjectOwned(c, projectId);
  const tasks = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE project_id = ?1 AND user_id = ?2 ORDER BY position, created_at`
  ).bind(projectId, c.get('user').id).all();
  const subtasks = await c.env.DB.prepare(
    `SELECT sb.* FROM subtasks sb JOIN tasks t ON t.id = sb.task_id
     WHERE t.project_id = ?1 AND sb.user_id = ?2 ORDER BY sb.position, sb.created_at`
  ).bind(projectId, c.get('user').id).all();
  return c.json({ tasks: tasks.results, subtasks: subtasks.results });
});

taskRoutes.post('/projects/:id/tasks', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProjectOwned(c, projectId);
  if (project.archived) return jsonError(422, 'archived', 'this project is archived — restore it to add tasks');
  const parsed = taskCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid task payload', parsed.error.flatten());
  await assertTaskLimit(c.env, c.get('user').id);

  const now = Date.now();
  const id = ulid(now);
  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE project_id = ?1'
  ).bind(projectId).first<{ p: number }>();
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 0, ?6, ?7, ?7)`
  ).bind(id, c.get('user').id, projectId, parsed.data.name, parsed.data.notes ?? '', (posRow?.p ?? -1) + 1, now).run();

  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first();
  const evs = await appendEvents(c.env, c.get('user').id,
    [{ type: 'task.created', actor: c.get('deviceId'), data: { task } }]);
  notifyHub(c.env, c.get('user').id, evs, c.executionCtx);
  return c.json({ task, events: evs }, 201);
});

taskRoutes.patch('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const existing = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!existing) return jsonError(404, 'not_found', 'task not found');
  const parsed = taskPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid task payload', parsed.error.flatten());
  const u = parsed.data;

  if (u.project_id && u.project_id !== existing.project_id) {
    const targetProject = (await getProjectOwned(c, u.project_id)) as { archived: number };
    await assertReparentSafe(c.env, userId, existing.id, u.project_id);
    // parity with task/session creation: no (re-)entry into archived projects
    if (targetProject.archived)
      return jsonError(422, 'archived', 'this project is archived — restore it to add tasks');
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) { sets.push('name = ?'); binds.push(u.name); }
  if (u.notes !== undefined) { sets.push('notes = ?'); binds.push(u.notes); }
  if (u.done !== undefined) { sets.push('done = ?'); binds.push(u.done ? 1 : 0); }
  if (u.position !== undefined) { sets.push('position = ?'); binds.push(u.position); }
  if (u.project_id !== undefined) { sets.push('project_id = ?'); binds.push(u.project_id); }
  if (sets.length === 0) return c.json({ task: existing });
  sets.push('updated_at = ?');
  binds.push(Date.now(), userId, existing.id);
  await c.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();

  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(existing.id).first();
  // "done" changes affect map badges + charts legend → task.updated covers both (FR-N2)
  const evs = await appendEvents(c.env, userId,
    [{ type: 'task.updated', actor: c.get('deviceId'), data: { task } }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ task, events: evs });
});

taskRoutes.delete('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!task) return jsonError(404, 'not_found', 'task not found');

  // One transactional batch: the reads (undo payload) and the delete observe a
  // consistent snapshot, so rows created concurrently can't vanish from the
  // payload while still being cascade-deleted.
  const [subtasks, deps, sessions, ,] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM subtasks WHERE task_id = ?1').bind(task.id),
    c.env.DB.prepare(
      `SELECT * FROM task_dependencies WHERE user_id = ?1 AND (task_id = ?2 OR depends_on_id = ?2)`
    ).bind(userId, task.id),
    c.env.DB.prepare('SELECT * FROM time_sessions WHERE task_id = ?1').bind(task.id),
    c.env.DB.prepare('DELETE FROM tasks WHERE id = ?1 AND user_id = ?2').bind(task.id, userId) // cascades to subtasks/deps/sessions
  ]);

  const evs = await appendEvents(c.env, userId, [{
    type: 'task.deleted', actor: c.get('deviceId'),
    data: { task, subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results }
  }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({
    deleted: true,
    undo: { tasks: [task], subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results },
    events: evs
  });
});

// ---------- subtasks (FR-T2) ----------

taskRoutes.post('/tasks/:id/subtasks', async (c) => {
  const userId = c.get('user').id;
  await assertNotSubtask(c.env, userId, c.req.param('id')); // FR-T3: clear message for sub-subtask attempts
  const parent = await requireRootTaskForSubtask(c.env, userId, c.req.param('id'));
  const parsed = subtaskCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid subtask payload', parsed.error.flatten());
  await assertSubtaskLimit(c.env, userId, parent.id);

  const now = Date.now();
  const id = ulid(now);
  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM subtasks WHERE task_id = ?1'
  ).bind(parent.id).first<{ p: number }>();
  await c.env.DB.prepare(
    `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`
  ).bind(id, parent.id, userId, parsed.data.name, (posRow?.p ?? -1) + 1, now).run();

  const subtask = await c.env.DB.prepare('SELECT * FROM subtasks WHERE id = ?1').bind(id).first();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'subtask.created', actor: c.get('deviceId'), data: { subtask, task_id: parent.id } }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ subtask, events: evs }, 201);
});

taskRoutes.patch('/subtasks/:id', async (c) => {
  const userId = c.get('user').id;
  const existing = await c.env.DB.prepare('SELECT * FROM subtasks WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!existing) return jsonError(404, 'not_found', 'subtask not found');
  const parsed = subtaskPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid subtask payload', parsed.error.flatten());
  const u = parsed.data;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) { sets.push('name = ?'); binds.push(u.name); }
  if (u.done !== undefined) { sets.push('done = ?'); binds.push(u.done ? 1 : 0); }
  if (u.position !== undefined) { sets.push('position = ?'); binds.push(u.position); }
  if (sets.length === 0) return c.json({ subtask: existing });
  binds.push(existing.id, userId);
  await c.env.DB.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();

  const subtask = await c.env.DB.prepare('SELECT * FROM subtasks WHERE id = ?1').bind(existing.id).first();
  // rapid toggles must never be lost (FR-M9 AC): each toggle is its own persisted event
  const type = u.done !== undefined && u.done !== !!existing.done ? 'subtask.toggled' : 'subtask.updated';
  const evs = await appendEvents(c.env, userId,
    [{ type, actor: c.get('deviceId'), data: { subtask } }] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ subtask, events: evs });
});

taskRoutes.delete('/subtasks/:id', async (c) => {
  const userId = c.get('user').id;
  const existing = await c.env.DB.prepare('SELECT * FROM subtasks WHERE id = ?1 AND user_id = ?2')
    .bind(c.req.param('id'), userId).first<any>();
  if (!existing) return jsonError(404, 'not_found', 'subtask not found');
  await c.env.DB.prepare('DELETE FROM subtasks WHERE id = ?1 AND user_id = ?2').bind(existing.id, userId).run();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'subtask.deleted', actor: c.get('deviceId'), data: { subtask: existing } }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ deleted: true, undo: { subtasks: [existing] }, events: evs });
});

// ---------- dependencies (FR-M2/M3/M4/M5) ----------

taskRoutes.get('/projects/:id/deps', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT td.* FROM task_dependencies td
     JOIN tasks t ON t.id = td.task_id
     WHERE t.project_id = ?1 AND td.user_id = ?2`
  ).bind(c.req.param('id'), c.get('user').id).all();
  return c.json({ dependencies: rows.results });
});

taskRoutes.post('/tasks/:id/deps', async (c) => {
  const userId = c.get('user').id;
  const parsed = depCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'depends_on_id required', parsed.error.flatten());
  const dep = await createDependency(c.env, userId, c.req.param('id'), parsed.data.depends_on_id);
  const evs = await appendEvents(c.env, userId,
    [{ type: 'dependency.created', actor: c.get('deviceId'), data: { dependency: dep } }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ dependency: dep, events: evs }, 201);
});

taskRoutes.delete('/tasks/:id/deps/:depId', async (c) => {
  const userId = c.get('user').id;
  const taskId = c.req.param('id');
  const depId = c.req.param('depId');
  const existing = await c.env.DB.prepare(
    `SELECT * FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2 AND user_id = ?3`
  ).bind(taskId, depId, userId).first();
  if (!existing) return jsonError(404, 'not_found', 'dependency not found');
  await c.env.DB.prepare(
    `DELETE FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2 AND user_id = ?3`
  ).bind(taskId, depId, userId).run();
  const evs = await appendEvents(c.env, userId,
    [{ type: 'dependency.deleted', actor: c.get('deviceId'), data: { dependency: existing } }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({ deleted: true, undo: { dependencies: [existing] }, events: evs });
});
