// FR-P: project CRUD, archive/restore, reorder, delete with typed confirmation client-side.
// Every mutation returns the updated entity and emits a sync_log event (FR-N2).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import type { Context } from 'hono';
import { jsonError } from '../env';
import { requireAuth } from '../middleware';
import { projectCreateSchema, projectPatchSchema, reorderSchema } from '../validators';
import { assertProjectLimit, RuleError, isUniqueConstraintError } from '../rules';
import { appendEvents, notifyHub, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { PALETTE } from '../../shared/constants';

export const projectRoutes = new Hono<WorkerType>();
projectRoutes.use('/projects', requireAuth);
projectRoutes.use('/projects/*', requireAuth);

async function getOwned(c: Context<WorkerType>, id: string) {
  const p = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?1 AND user_id = ?2'
  ).bind(id, c.get('user').id).first();
  if (!p) throw new RuleError(404, 'not_found', 'project not found');
  return p as any;
}

projectRoutes.get('/projects', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, color, archived, position, created_at, updated_at
     FROM projects WHERE user_id = ?1 ORDER BY position, created_at`
  ).bind(c.get('user').id).all();
  return c.json({ projects: rows.results });
});

projectRoutes.post('/projects', async (c) => {
  const parsed = projectCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid project payload', parsed.error.flatten());
  await assertProjectLimit(c.env, c.get('user').id);

  const now = Date.now();
  const id = ulid(now);
  const color = parsed.data.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM projects WHERE user_id = ?1'
  ).bind(c.get('user').id).first<{ p: number }>();

  try {
    await c.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)`
    ).bind(id, c.get('user').id, parsed.data.name, color, (posRow?.p ?? -1) + 1, now).run();
  } catch (e: any) {
    if (isUniqueConstraintError(e)) // UNIQUE(user_id, name)
      return jsonError(422, 'duplicate', 'a project with this name already exists');
    throw e;
  }

  const project = await getOwned(c, id);
  const drafts: EventDraft[] = [{ type: 'project.created', actor: c.get('deviceId'), data: { project } }];
  const evs = await appendEvents(c.env, c.get('user').id, drafts);
  notifyHub(c.env, c.get('user').id, evs, c.executionCtx);
  return c.json({ project, events: evs }, 201);
});

projectRoutes.patch('/projects/:id', async (c) => {
  const existing = await getOwned(c, c.req.param('id'));
  const parsed = projectPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid project payload', parsed.error.flatten());
  const u = parsed.data;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) { sets.push('name = ?'); binds.push(u.name); }
  if (u.color !== undefined) { sets.push('color = ?'); binds.push(u.color); }
  if (u.archived !== undefined) { sets.push('archived = ?'); binds.push(u.archived ? 1 : 0); }
  if (u.position !== undefined) { sets.push('position = ?'); binds.push(u.position); }
  if (sets.length === 0) return c.json({ project: existing });
  sets.push('updated_at = ?');
  binds.push(Date.now(), c.get('user').id, existing.id);

  try {
    await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  } catch (e: any) {
    if (isUniqueConstraintError(e))
      return jsonError(422, 'duplicate', 'a project with this name already exists');
    throw e;
  }
  const project = await getOwned(c, existing.id);
  const evs = await appendEvents(c.env, c.get('user').id,
    [{ type: 'project.updated', actor: c.get('deviceId'), data: { project } }]);
  notifyHub(c.env, c.get('user').id, evs, c.executionCtx);
  return c.json({ project, events: evs });
});

projectRoutes.post('/projects/reorder', async (c) => {
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !parsed.data.ids) return jsonError(422, 'validation', 'ids required');
  const now = Date.now();
  const stmts = parsed.data.ids.map((id, i) =>
    c.env.DB.prepare('UPDATE projects SET position = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4')
      .bind(i, now, id, c.get('user').id)
  );
  // chunked like import/layout — stay under D1 batch statement limits
  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }
  const evs = await appendEvents(c.env, c.get('user').id,
    [{ type: 'project.updated', actor: c.get('deviceId'), data: { reordered: parsed.data.ids } }]);
  notifyHub(c.env, c.get('user').id, evs, c.executionCtx);
  return c.json({ ok: true, events: evs });
});

/**
 * Delete returns the deleted subtree for the 5-second undo toast (FR-T4):
 * undo posts it to POST /api/restore which re-inserts the identical rows by id.
 */
projectRoutes.delete('/projects/:id', async (c) => {
  const project = await getOwned(c, c.req.param('id'));
  const userId = c.get('user').id;

  // One transactional batch: scoped SQL (no whole-table loads filtered in JS)
  // plus the delete observe one consistent snapshot, so rows created
  // concurrently can't be cascade-deleted while missing from the undo payload.
  const [tasks, subtasks, deps, sessions, ,] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM tasks WHERE project_id = ?1 AND user_id = ?2')
      .bind(project.id, userId),
    c.env.DB.prepare(
      `SELECT sb.* FROM subtasks sb
       WHERE sb.user_id = ?1 AND sb.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`
    ).bind(userId, project.id),
    c.env.DB.prepare(
      `SELECT td.* FROM task_dependencies td
       WHERE td.user_id = ?1 AND (td.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)
          OR td.depends_on_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1))`
    ).bind(userId, project.id),
    c.env.DB.prepare(
      `SELECT s.* FROM time_sessions s
       WHERE s.user_id = ?1 AND s.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`
    ).bind(userId, project.id),
    c.env.DB.prepare('DELETE FROM projects WHERE id = ?1 AND user_id = ?2')
      .bind(project.id, userId) // cascades
  ]);

  const evs = await appendEvents(c.env, userId, [{
    type: 'project.deleted', actor: c.get('deviceId'),
    data: { project, tasks: tasks.results, subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results }
  }]);
  notifyHub(c.env, userId, evs, c.executionCtx);
  return c.json({
    deleted: true,
    undo: { project, tasks: tasks.results, subtasks: subtasks.results, dependencies: deps.results, sessions: sessions.results },
    events: evs
  });
});
