// FR-T: tasks, subtask check-lists (two-level, FR-T3), dependency DAG edges
// (cycle-checked, FR-M4). Deleting returns the undo payload (FR-T4).
// Phase 4: group projects — every access goes through worker/access.ts:
// members read everything in the project; structure edits need `edit_tasks`;
// events fan out to the whole group. Sessions stay strictly user-owned.
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import type { Context } from 'hono';
import { jsonError } from '../env';
import { requireAuth } from '../middleware';
import { taskCreateSchema, taskPatchSchema, subtaskCreateSchema, subtaskPatchSchema, depCreateSchema } from '../validators';
import {
  assertTaskLimit, assertSubtaskLimit, assertNotSubtask,
  createDependency, assertReparentSafe, RuleError
} from '../rules';
import { appendEvents, notifyHub, emitEntityEvents, EventDraft } from '../events';
import { requireProjectAccess, requireTaskAccess, requireEditTasks } from '../access';
import { ulid } from '../../shared/ids';
import { findCyclePath } from '../../shared/validation';

export const taskRoutes = new Hono<WorkerType>();
taskRoutes.use('/tasks', requireAuth);
taskRoutes.use('/tasks/*', requireAuth);
taskRoutes.use('/subtasks', requireAuth);
taskRoutes.use('/subtasks/*', requireAuth);
taskRoutes.use('/projects/*', requireAuth);

// ---------- tasks ----------

taskRoutes.get('/projects/:id/tasks', async (c) => {
  const projectId = c.req.param('id');
  const access = await requireProjectAccess(c.env, c.get('user').id, projectId);
  // group projects expose every member's tasks; personal projects are owner-only anyway
  const tasks = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE project_id = ?1 ORDER BY position, created_at`
  ).bind(projectId).all();
  const subtasks = await c.env.DB.prepare(
    `SELECT sb.* FROM subtasks sb JOIN tasks t ON t.id = sb.task_id
     WHERE t.project_id = ?1 ORDER BY sb.position, sb.created_at`
  ).bind(projectId).all();
  void access;
  return c.json({ tasks: tasks.results, subtasks: subtasks.results });
});

taskRoutes.post('/projects/:id/tasks', async (c) => {
  const projectId = c.req.param('id');
  const access = await requireEditTasks(c.env, c.get('user').id, projectId);
  if (access.project.archived) return jsonError(422, 'archived', 'this project is archived — restore it to add tasks');
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
  const evs = await emitEntityEvents(c.env, c.get('user').id, projectId,
    [{ type: 'task.created', actor: c.get('deviceId'), data: { task } }], c.executionCtx);
  return c.json({ task, events: evs }, 201);
});

taskRoutes.patch('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const { task: existing, access } = await requireTaskAccess(c.env, userId, c.req.param('id'));
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');
  const parsed = taskPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid task payload', parsed.error.flatten());
  const u = parsed.data;

  if (u.project_id && u.project_id !== existing.project_id) {
    const target = await requireProjectAccess(c.env, userId, u.project_id);
    if (access.isGroup !== target.isGroup || access.project.group_id !== target.project.group_id) {
      // moving between personal ↔ group (or across groups) would change the
      // task's audience mid-flight — not supported; delete + recreate instead
      return jsonError(422, 'cross_scope_move', 'tasks cannot move between projects with different access');
    }
    await assertReparentSafe(c.env, userId, existing.id, u.project_id, access.isGroup ? null : userId);
    // parity with task/session creation: no (re-)entry into archived projects
    if (target.project.archived)
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
  binds.push(Date.now(), existing.id);
  await c.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(existing.id).first();
  // "done" changes affect map badges + charts legend → task.updated covers both (FR-N2)
  const evs = await emitEntityEvents(c.env, userId, existing.project_id,
    [{ type: 'task.updated', actor: c.get('deviceId'), data: { task } }], c.executionCtx);
  return c.json({ task, events: evs });
});

taskRoutes.delete('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const { task, access } = await requireTaskAccess(c.env, userId, c.req.param('id'));
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');

  // One transactional batch: the reads (event/undo payload) and the delete
  // observe a consistent snapshot. For group tasks the reads are deliberately
  // NOT user-scoped — the deletion hits every member, so every device needs
  // the full payload to clean up (and group deletes carry no undo).
  const [subtasks, deps, sessions, ,] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM subtasks WHERE task_id = ?1').bind(task.id),
    c.env.DB.prepare(`SELECT * FROM task_dependencies WHERE task_id = ?1 OR depends_on_id = ?1`).bind(task.id),
    c.env.DB.prepare('SELECT * FROM time_sessions WHERE task_id = ?1').bind(task.id),
    c.env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(task.id) // cascades to subtasks/deps/sessions
  ]);

  const evs = await emitEntityEvents(c.env, userId, task.project_id, [{
    type: 'task.deleted', actor: c.get('deviceId'),
    data: { task, subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results }
  }], c.executionCtx);
  if (access.isGroup) return c.json({ deleted: true, undo: null, events: evs });
  return c.json({
    deleted: true,
    undo: { tasks: [task], subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results },
    events: evs
  });
});

// ---------- subtasks (FR-T2) ----------

taskRoutes.post('/tasks/:id/subtasks', async (c) => {
  const userId = c.get('user').id;
  await assertNotSubtask(c.env, c.req.param('id')); // FR-T3: clear message for sub-subtask attempts
  const { task: parent, access } = await requireTaskAccess(c.env, userId, c.req.param('id'));
  if (parent.parent_id !== null)
    return jsonError(422, 'two_level_hierarchy', "a subtask can't have subtasks");
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');
  const parsed = subtaskCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid subtask payload', parsed.error.flatten());
  await assertSubtaskLimit(c.env, userId, parent.id as string);

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
  const evs = await emitEntityEvents(c.env, userId, parent.project_id as string,
    [{ type: 'subtask.created', actor: c.get('deviceId'), data: { subtask, task_id: parent.id } }], c.executionCtx);
  return c.json({ subtask, events: evs }, 201);
});

taskRoutes.patch('/subtasks/:id', async (c) => {
  const userId = c.get('user').id;
  // resolve through the parent task's project — group membership grants access
  const row = await c.env.DB.prepare(
    `SELECT sb.*, t.project_id, t.user_id AS task_user_id FROM subtasks sb JOIN tasks t ON t.id = sb.task_id
     WHERE sb.id = ?1`
  ).bind(c.req.param('id')).first<any>();
  if (!row) return jsonError(404, 'not_found', 'subtask not found');
  const access = await requireProjectAccess(c.env, userId, row.project_id);
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');
  if (!access.isGroup && row.user_id !== userId)
    return jsonError(404, 'not_found', 'subtask not found');
  const parsed = subtaskPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid subtask payload', parsed.error.flatten());
  const u = parsed.data;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) { sets.push('name = ?'); binds.push(u.name); }
  if (u.done !== undefined) { sets.push('done = ?'); binds.push(u.done ? 1 : 0); }
  if (u.position !== undefined) { sets.push('position = ?'); binds.push(u.position); }
  if (sets.length === 0) return c.json({ subtask: row });
  binds.push(row.id);
  await c.env.DB.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  const subtask = await c.env.DB.prepare('SELECT * FROM subtasks WHERE id = ?1').bind(row.id).first();
  // rapid toggles must never be lost (FR-M9 AC): each toggle is its own persisted event
  const type = u.done !== undefined && u.done !== !!row.done ? 'subtask.toggled' : 'subtask.updated';
  const evs = await emitEntityEvents(c.env, userId, row.project_id,
    [{ type, actor: c.get('deviceId'), data: { subtask } }] as EventDraft[], c.executionCtx);
  return c.json({ subtask, events: evs });
});

taskRoutes.delete('/subtasks/:id', async (c) => {
  const userId = c.get('user').id;
  const row = await c.env.DB.prepare(
    `SELECT sb.*, t.project_id FROM subtasks sb JOIN tasks t ON t.id = sb.task_id
     WHERE sb.id = ?1`
  ).bind(c.req.param('id')).first<any>();
  if (!row) return jsonError(404, 'not_found', 'subtask not found');
  const access = await requireProjectAccess(c.env, userId, row.project_id);
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');
  if (!access.isGroup && row.user_id !== userId)
    return jsonError(404, 'not_found', 'subtask not found');

  await c.env.DB.prepare('DELETE FROM subtasks WHERE id = ?1').bind(row.id).run();
  const evs = await emitEntityEvents(c.env, userId, row.project_id,
    [{ type: 'subtask.deleted', actor: c.get('deviceId'), data: { subtask: row } }], c.executionCtx);
  return c.json({ deleted: true, undo: access.isGroup ? null : { subtasks: [row] }, events: evs });
});

// ---------- dependencies (FR-M2/M3/M4/M5) ----------

taskRoutes.get('/projects/:id/deps', async (c) => {
  const projectId = c.req.param('id');
  await requireProjectAccess(c.env, c.get('user').id, projectId);
  const rows = await c.env.DB.prepare(
    `SELECT td.* FROM task_dependencies td
     JOIN tasks t ON t.id = td.task_id
     WHERE t.project_id = ?1`
  ).bind(projectId).all();
  return c.json({ dependencies: rows.results });
});

taskRoutes.post('/tasks/:id/deps', async (c) => {
  const userId = c.get('user').id;
  const parsed = depCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'depends_on_id required', parsed.error.flatten());
  // both endpoints must live in an editable project (group → edit_tasks)
  const { task } = await requireTaskAccess(c.env, userId, c.req.param('id'));
  const projectAccess = await requireEditTasks(c.env, userId, task.project_id as string);
  const { task: other } = await requireTaskAccess(c.env, userId, parsed.data.depends_on_id);
  if (other.project_id !== task.project_id)
    return jsonError(422, 'cross_project_edge', 'dependencies may only connect tasks of the same project');

  const dep = await createDependency(c.env, userId, c.req.param('id'), parsed.data.depends_on_id,
    projectAccess.isGroup ? null : userId);
  const evs = await emitEntityEvents(c.env, userId, task.project_id as string,
    [{ type: 'dependency.created', actor: c.get('deviceId'), data: { dependency: dep } }], c.executionCtx);
  return c.json({ dependency: dep, events: evs }, 201);
});

taskRoutes.delete('/tasks/:id/deps/:depId', async (c) => {
  const userId = c.get('user').id;
  const taskId = c.req.param('id');
  const depId = c.req.param('depId');
  const { task, access } = await requireTaskAccess(c.env, userId, taskId);
  if (access.isGroup && !access.canEditTasks)
    return jsonError(403, 'forbidden', 'missing permission: edit_tasks');
  const existing = await c.env.DB.prepare(
    `SELECT * FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2`
  ).bind(taskId, depId).first();
  if (!existing) return jsonError(404, 'not_found', 'dependency not found');
  await c.env.DB.prepare(
    `DELETE FROM task_dependencies WHERE task_id = ?1 AND depends_on_id = ?2`
  ).bind(taskId, depId).run();
  const evs = await emitEntityEvents(c.env, userId, task.project_id as string,
    [{ type: 'dependency.deleted', actor: c.get('deviceId'), data: { dependency: existing } }], c.executionCtx);
  return c.json({ deleted: true, undo: access.isGroup ? null : { dependencies: [existing] }, events: evs });
});
