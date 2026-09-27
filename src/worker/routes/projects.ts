// FR-P: project CRUD, archive/restore, reorder, delete with typed confirmation client-side.
// Every mutation returns the updated entity and emits a sync_log event (FR-N2).
// Phase 4: group projects — visible to all current members; edits gate on the
// per-member perms (edit_tasks / manage_projects) via worker/access.ts.
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitWrites } from '../middleware';
import { projectCreateSchema, projectPatchSchema, reorderSchema } from '../validators';
import { assertProjectLimit, isUniqueConstraintError } from '../rules';
import { commitWithEvents, emitEntityEvents, emitToUsers, EventDraft } from '../events';
import { requireProjectAccess } from '../access';
import { ulid } from '../../shared/ids';
import { PALETTE } from '../../shared/constants';

export const projectRoutes = new Hono<WorkerType>();
projectRoutes.use('/projects', requireAuth, limitWrites);
projectRoutes.use('/projects/*', requireAuth, limitWrites);

// ---------- read ----------

projectRoutes.get('/projects', async (c) => {
  const me = c.get('user').id;
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, name, color, archived, position, visibility, group_id, created_at, updated_at
     FROM projects
     WHERE deleted_at IS NULL
       AND (user_id = ?1 OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1))
     ORDER BY position, created_at`,
  )
    .bind(me)
    .all();
  return c.json({ projects: rows.results });
});

// ---------- create (personal only — group projects go through /groups/:id/projects) ----------

projectRoutes.post('/projects', async (c) => {
  const parsed = projectCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid project payload', parsed.error.flatten());
  await assertProjectLimit(c.env, c.get('user').id);

  const now = Date.now();
  const id = ulid(now);
  const color = parsed.data.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
  // `projects` keeps its inline UNIQUE(user_id, name) — swapping it for a
  // partial one would mean rebuilding the table, which is unsafe in D1
  // (0003/AGENTS.md) and would cascade-delete every task under it. So a
  // TOMBSTONED project still holds its name, and re-creating a project with that
  // name renames the tombstone out of the way instead (INV-06: the point is that
  // history survives, not that a deleted name is reserved forever). The rename
  // carries a date so the tombstone stays identifiable in the UI.
  const clash = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE AND deleted_at IS NOT NULL`,
  )
    .bind(c.get('user').id, parsed.data.name)
    .first<{ id: string }>();
  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM projects WHERE user_id = ?1 AND group_id IS NULL AND deleted_at IS NULL',
  )
    .bind(c.get('user').id)
    .first<{ p: number }>();

  // The INSERT and the event in ONE batch (INV-11). The project row is built
  // here rather than re-read: the batch is the commit, and a read-back would
  // also be a second statement that can disagree with what was written.
  const project = {
    id,
    user_id: c.get('user').id,
    name: parsed.data.name,
    color,
    archived: 0,
    position: (posRow?.p ?? -1) + 1,
    group_id: null,
    visibility: 'private',
    created_at: now,
    updated_at: now,
  };
  try {
    const drafts: EventDraft[] = [{ type: 'project.created', actor: c.get('deviceId'), data: { project } }];
    const evs = await commitWithEvents(
      c.env,
      c.get('user').id,
      drafts,
      [
        // free the name held by a tombstone FIRST — same transaction, so the
        // unique index can never be caught mid-way (an INSERT before the rename
        // would trip the constraint and roll the whole batch back)
        ...(clash
          ? [
              c.env.DB.prepare('UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3').bind(
                `${parsed.data.name} (deleted ${new Date(now).toISOString().slice(0, 10)})`,
                now,
                clash.id,
              ),
            ]
          : []),
        c.env.DB.prepare(
          `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)`,
        ).bind(id, c.get('user').id, parsed.data.name, color, (posRow?.p ?? -1) + 1, now),
      ],
      c.executionCtx,
    );
    return c.json({ project, events: evs }, 201);
  } catch (e: any) {
    if (isUniqueConstraintError(e))
      // UNIQUE(user_id, name) — the whole batch rolled back, event included
      return jsonError(422, 'duplicate', 'a project with this name already exists');
    throw e;
  }
});

// ---------- patch / delete ----------

projectRoutes.patch('/projects/:id', async (c) => {
  const access = await requireProjectAccess(c.env, c.get('user').id, c.req.param('id'));
  const existing = access.project;
  const parsed = projectPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid project payload', parsed.error.flatten());
  const u = parsed.data;
  if (u.visibility !== undefined && access.isGroup)
    return jsonError(422, 'validation', 'group projects are visible to members only — no friend visibility');

  // structure edits: personal = owner; group = manage_projects
  if (access.isGroup && !access.canManage) return jsonError(403, 'forbidden', 'missing permission: manage_projects');

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) {
    sets.push('name = ?');
    binds.push(u.name);
  }
  if (u.color !== undefined) {
    sets.push('color = ?');
    binds.push(u.color);
  }
  if (u.archived !== undefined) {
    sets.push('archived = ?');
    binds.push(u.archived ? 1 : 0);
  }
  if (u.position !== undefined) {
    sets.push('position = ?');
    binds.push(u.position);
  }
  if (u.visibility !== undefined) {
    sets.push('visibility = ?');
    binds.push(u.visibility);
  }
  if (sets.length === 0) return c.json({ project: existing });
  sets.push('updated_at = ?');
  // bind order matches the SQL: …, updated_at = ? WHERE id = ? AND user_id = ?
  const now = Date.now();
  binds.push(now, existing.id, c.get('user').id);

  try {
    const up = await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...binds)
      .run();
    if ((up.meta.changes ?? 0) === 0) return jsonError(404, 'not_found', 'project not found');
  } catch (e: any) {
    if (isUniqueConstraintError(e)) return jsonError(422, 'duplicate', 'a project with this name already exists');
    throw e;
  }
  // construct the updated row from the known SETs — the re-read round trip
  // measurably slowed archive/rename (every field is app-supplied; nothing is
  // DB-computed)
  const project = {
    ...existing,
    ...(u.name !== undefined ? { name: u.name } : {}),
    ...(u.color !== undefined ? { color: u.color } : {}),
    ...(u.archived !== undefined ? { archived: (u.archived ? 1 : 0) as 0 | 1 } : {}),
    ...(u.position !== undefined ? { position: u.position } : {}),
    ...(u.visibility !== undefined ? { visibility: u.visibility } : {}),
    updated_at: now,
  };
  const evs = await emitEntityEvents(
    c.env,
    c.get('user').id,
    existing.id,
    [{ type: 'project.updated', actor: c.get('deviceId'), data: { project } }],
    c.executionCtx,
    access.project.group_id ?? null,
  );
  return c.json({ project, events: evs });
});

projectRoutes.post('/projects/reorder', async (c) => {
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !parsed.data.ids) return jsonError(422, 'validation', 'ids required');
  const now = Date.now();
  // personal projects only — group projects order by their own position writes
  // (manage_projects) and are not drag-reorderable from the personal tree
  const stmts = parsed.data.ids.map((id, i) =>
    c.env.DB.prepare(
      'UPDATE projects SET position = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4 AND group_id IS NULL',
    ).bind(i, now, id, c.get('user').id),
  );
  // chunked like import/layout — stay under D1 batch statement limits
  // Reorder and its event in ONE batch (INV-11). This is the whole payload —
  // 200 ids is well under the batch statement limit — so there is no reason for
  // the event to be a second round trip.
  const evs = await commitWithEvents(
    c.env,
    c.get('user').id,
    [{ type: 'project.updated', actor: c.get('deviceId'), data: { reordered: parsed.data.ids } }],
    stmts,
    c.executionCtx,
  );
  return c.json({ ok: true, events: evs });
});

/**
 * Delete TOMBSTONES the project and its tasks (INV-06) and returns the subtree
 * for the 5-second undo toast (FR-T4): undo posts it to POST /api/restore,
 * which clears `deleted_at` again.
 *
 * Nothing is cascade-deleted. That used to be the case, and for a GROUP project
 * it meant one member deleting shared metadata destroyed every OTHER member's
 * time_sessions through the `time_sessions.task_id` FK — historical records that
 * are not the deleter's to destroy. Now the rows stay with `deleted_at` set:
 * invisible to every live listing, fully present in history and reports.
 *
 * GROUP projects still carry NO undo: the tombstone hits every member's view, so
 * it is one-way from the UI (typed confirmation) and the event payload carries
 * everyone's rows so all their devices clean up.
 */
projectRoutes.delete('/projects/:id', async (c) => {
  const access = await requireProjectAccess(c.env, c.get('user').id, c.req.param('id'));
  if (access.isGroup && !access.canManage) return jsonError(403, 'forbidden', 'missing permission: manage_projects');
  const project = access.project;
  const userId = c.get('user').id;
  const now = Date.now();

  if (access.isGroup) {
    // group path: sweep EVERY member's rows into the event payload (all
    // devices drop their local copies), then tombstone the project and its
    // tasks in the same transaction. The sessions stay where they are.
    const [tasks, subtasks, deps] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL').bind(project.id).all(),
      c.env.DB.prepare('SELECT sb.* FROM subtasks sb JOIN tasks t ON t.id = sb.task_id WHERE t.project_id = ?1')
        .bind(project.id)
        .all(),
      c.env.DB.prepare(
        `SELECT td.* FROM task_dependencies td JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?1`,
      )
        .bind(project.id)
        .all(),
    ]);
    // NOTE: emit per-member directly — emitEntityEvents re-reads the project
    // row, and the group_id comes from the pre-delete access.
    const members = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?1')
      .bind(project.group_id)
      .all<{ user_id: string }>();
    const draft: EventDraft = {
      type: 'project.deleted',
      actor: c.get('deviceId'),
      data: {
        project: { ...project, deleted_at: now },
        tasks: tasks.results.map((t: any) => ({ ...t, deleted_at: now })),
        subtasks: subtasks.results,
        dependencies: deps.results,
        // deliberately empty: the sessions are history and stay put (INV-06)
        sessions: [],
      },
    };
    await emitToUsers(
      c.env,
      members.results.map((m) => ({ userId: m.user_id, draft })),
      c.executionCtx,
      [
        c.env.DB.prepare('UPDATE projects SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, project.id),
        c.env.DB.prepare(
          'UPDATE tasks SET deleted_at = ?1, updated_at = ?1 WHERE project_id = ?2 AND deleted_at IS NULL',
        ).bind(now, project.id),
      ],
    );
    return c.json({ deleted: true, undo: null, events: [] });
  }

  // personal path: one batch for the reads (undo payload) — they observe a
  // consistent snapshot — and the tombstone rides in the fan-out's transaction.
  const [tasks, subtasks, deps, sessions, ,] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM tasks WHERE project_id = ?1 AND user_id = ?2 AND deleted_at IS NULL').bind(
      project.id,
      userId,
    ),
    c.env.DB.prepare(
      `SELECT sb.* FROM subtasks sb
       WHERE sb.user_id = ?1 AND sb.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`,
    ).bind(userId, project.id),
    c.env.DB.prepare(
      `SELECT td.* FROM task_dependencies td
       WHERE td.user_id = ?1 AND (td.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)
          OR td.depends_on_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1))`,
    ).bind(userId, project.id),
    c.env.DB.prepare(
      `SELECT s.* FROM time_sessions s
       WHERE s.user_id = ?1 AND s.task_id IN (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`,
    ).bind(userId, project.id),
  ]);

  const evs = await emitEntityEvents(
    c.env,
    userId,
    project.id,
    [
      {
        type: 'project.deleted',
        actor: c.get('deviceId'),
        data: {
          project: { ...project, deleted_at: now },
          tasks: tasks.results.map((t: any) => ({ ...t, deleted_at: now })),
          subtasks: subtasks.results,
          dependencies: deps.results,
          sessions: [],
        },
      },
    ],
    c.executionCtx,
    undefined,
    [
      c.env.DB.prepare(
        'UPDATE projects SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL',
      ).bind(now, project.id, userId),
      c.env.DB.prepare(
        `UPDATE tasks SET deleted_at = ?1, updated_at = ?1
           WHERE project_id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
      ).bind(now, project.id, userId),
    ],
  );
  return c.json({
    deleted: true,
    // the payload re-inserts the identical rows by id; with a tombstone they
    // were never actually removed, so the restore just clears deleted_at
    undo: {
      project,
      tasks: tasks.results,
      subtasks: subtasks.results,
      dependencies: deps.results,
      sessions: sessions.results,
    },
    events: evs,
  });
});
