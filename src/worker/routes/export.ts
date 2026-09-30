// FR-D1/D2: data portability — inline JSON/CSV export, import (merge-by-id upsert
// or duplicate-with-new-ids), and the restore endpoint backing the 5-second
// undo toasts (FR-T4: "undo restores the identical row", ids preserved).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy } from '../middleware';
import {
  importSchema,
  restoreSchema,
  settingsSchema,
  importProjectRow,
  importTaskRow,
  importSubtaskRow,
  importDependencyRow,
  importSessionRow,
  importGoalRow,
} from '../validators';
import { ulid, isUlid } from '../../shared/ids';
import { EXPORT_SCHEMA_VERSION, LIMITS, SESSION_RULES } from '../../shared/constants';
import { findCyclePath } from '../../shared/validation';
import { appendEvents, notifyHub, EventDraft } from '../events';
import { mergeSettings } from './misc';
import { wroteOne, RuleError } from '../rules';
import { assertScopeAccessible } from './goals';
export const exportRoutes = new Hono<WorkerType>();
exportRoutes.use('/export', requireAuth);
exportRoutes.use('/export/*', requireAuth);
exportRoutes.use('/import', requireAuth);
exportRoutes.use('/restore', requireAuth);

// ---------- export (FR-D1) ----------

exportRoutes.get('/export', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const format = c.req.query('format') ?? 'json';

  // NOTE: all tables are buffered in memory before responding (bounded by the
  // per-account LIMITS). Chunked/streaming export is a future optimization.
  const [user, settingsRow, projects, tasks, subtasks, deps, sessions, goals] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start, theme, created_at FROM users WHERE id = ?1',
    )
      .bind(userId)
      .first(),
    c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1').bind(userId).first<{ data: string }>(),
    c.env.DB.prepare('SELECT * FROM projects WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM tasks WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM subtasks WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM task_dependencies WHERE user_id = ?1').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM time_sessions WHERE user_id = ?1 ORDER BY started_at').bind(userId).all(),
    // goals ride the export too (audit F19) — everything except user_id, which
    // the server stamps on import
    c.env.DB.prepare(
      'SELECT id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at FROM goals WHERE user_id = ?1 ORDER BY created_at',
    )
      .bind(userId)
      .all(),
  ]);

  if (format === 'csv') {
    const rows = sessions.results as any[];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // OWASP CSV formula injection: neutralize spreadsheet-active leading chars
    const csvSafe = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    };
    const lines = ['project,task,start_iso,end_iso,duration_min,source,note'];
    // map lookups (O(1)) — a per-row .find() over all tasks is O(sessions ×
    // tasks) and blows the Worker CPU budget on large accounts
    const taskById = new Map((tasks.results as any[]).map((t) => [t.id, t]));
    const projName = new Map((projects.results as any[]).map((p) => [p.id, p.name]));
    for (const s of rows) {
      const mins = Math.round(((s.ended_at ?? Date.now()) - s.started_at) / 60000);
      const projectId = taskById.get(s.task_id)?.project_id;
      lines.push(
        [
          esc(csvSafe(projectId != null ? (projName.get(projectId) ?? '') : '')),
          esc(csvSafe(taskById.get(s.task_id)?.name ?? '')),
          new Date(s.started_at).toISOString(),
          s.ended_at ? new Date(s.ended_at).toISOString() : '',
          String(mins),
          esc(csvSafe(s.source)),
          esc(csvSafe(s.note)),
        ].join(','),
      );
    }
    return new Response(lines.join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="timekeep-sessions.csv"`,
      },
    });
  }

  const payload = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: Date.now(),
    user,
    settings: settingsRow ? safeJson(settingsRow.data) : {},
    projects: projects.results,
    tasks: tasks.results,
    subtasks: subtasks.results,
    dependencies: deps.results,
    sessions: sessions.results,
    goals: goals.results,
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="timekeep-export.json"`,
    },
  });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------- import (FR-D2) ----------

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Hard cap for import/restore bodies (audit: the row-count guards are
 *  unreachable for multi-MB payloads — CPU/memory dies first). ~8 MB is
 *  comfortably above any legitimate export (200k sessions ≈ 56 MB only for
 *  JSON export OUTPUT; imports that large are invalid by the row caps anyway). */
const IMPORT_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** Ids of `table` rows owned by the user among `ids` (chunked under D1's 100-param limit). */
async function existingIds(
  env: WorkerType['Bindings'],
  userId: string,
  table: string,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(ids, 90)) {
    const marks = part.map((_, k) => `?${k + 2}`).join(',');
    const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ?1 AND id IN (${marks})`)
      .bind(userId, ...part)
      .all<{ id: string }>();
    for (const r of rows.results) out.add(r.id);
  }
  return out;
}

/** Ids of `table` rows that exist but belong to SOMEONE ELSE among `ids`
 *  (audit F3 fix #1: rows whose own id is foreign are SKIPPED — the upserts'
 *  `WHERE user_id = excluded.user_id` only stopped OVERWRITES, not inserts of
 *  rows that reference foreign owners). */
async function foreignIds(
  env: WorkerType['Bindings'],
  userId: string,
  table: string,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(ids, 90)) {
    if (part.length === 0) continue;
    const marks = part.map((_, k) => `?${k + 2}`).join(',');
    const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id <> ?1 AND id IN (${marks})`)
      .bind(userId, ...part)
      .all<{ id: string }>();
    for (const r of rows.results) out.add(r.id);
  }
  return out;
}

/** Count rows in a user-scoped table. */
async function countFor(env: WorkerType['Bindings'], userId: string, table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

exportRoutes.post('/import', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  // a payload large enough to matter dies here, not in a D1 bind (audit: the
  // restoreMaxRows row guard alone is theater for multi-MB bodies)
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > IMPORT_BODY_MAX_BYTES) return jsonError(413, 'too_large', 'import payload too large');
  const userId = c.get('user').id;
  const parsed = await importSchema.safeParseAsync(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid import payload', parsed.error.flatten());
  const { mode, data } = parsed.data;
  const now = Date.now();
  const summary = {
    projects: { created: 0, updated: 0, skipped: 0 },
    tasks: { created: 0, updated: 0, skipped: 0 },
    subtasks: { created: 0, updated: 0, skipped: 0 },
    dependencies: { created: 0, updated: 0, skipped: 0 },
    sessions: { created: 0, updated: 0, skipped: 0 },
    goals: { created: 0, updated: 0, skipped: 0 },
  };

  // duplicate mode: remap every id to a fresh one (project → task → subtask → dep → session → goal)
  const map = new Map<string, string>();
  if (mode === 'duplicate') {
    for (const coll of [data.projects, data.tasks, data.subtasks, data.sessions, data.goals]) {
      for (const row of coll) if (row?.id && typeof row.id === 'string') map.set(row.id, ulid(now + map.size));
    }
  }
  const idOf = (ref: unknown): string =>
    mode === 'duplicate' && typeof ref === 'string' && map.has(ref) ? map.get(ref)! : (ref as string);

  // entity-count limits — the same ceilings the CRUD routes enforce
  const [nProjects, nTasks, nSessions] = await Promise.all([
    countFor(c.env, userId, 'projects'),
    countFor(c.env, userId, 'tasks'),
    countFor(c.env, userId, 'time_sessions'),
  ]);
  if (nProjects + data.projects.length > LIMITS.projectsActive)
    return jsonError(422, 'limit', `import rejected: at most ${LIMITS.projectsActive} projects per account`);
  if (nTasks + data.tasks.length > LIMITS.tasksPerUser)
    return jsonError(422, 'limit', `import rejected: at most ${LIMITS.tasksPerUser} tasks per account`);
  if (nSessions + data.sessions.length > LIMITS.sessionsPerUser)
    return jsonError(422, 'limit', `import rejected: at most ${LIMITS.sessionsPerUser} sessions per account`);

  // per-task subtask ceiling (100/task, FR-T3)
  const incomingSubtasksByTask = new Map<string, number>();
  for (const s of data.subtasks as any[]) {
    const tid = typeof s?.task_id === 'string' ? s.task_id : '';
    if (tid) incomingSubtasksByTask.set(tid, (incomingSubtasksByTask.get(tid) ?? 0) + 1);
  }
  if (incomingSubtasksByTask.size) {
    const existing = await c.env.DB.prepare(
      `SELECT task_id, COUNT(*) AS n FROM subtasks WHERE user_id = ?1 AND task_id IN
       (SELECT value FROM json_each(?2)) GROUP BY task_id`,
    )
      .bind(userId, JSON.stringify([...incomingSubtasksByTask.keys()]))
      .all<{ task_id: string; n: number }>();
    for (const row of existing.results) {
      if (Number(row.n) + (incomingSubtasksByTask.get(row.task_id) ?? 0) > LIMITS.subtasksPerTask)
        return jsonError(422, 'limit', `import rejected: at most ${LIMITS.subtasksPerTask} subtasks per task`);
    }
  }

  /** created_at is clampable per row, but never beyond `now` (audit S3.6). */
  const clampTs = (v: number): number => (v > 0 ? Math.min(v, now) : now);

  // per-row schema validation (audit S3): a malformed row is skipped + counted,
  // never a 500. merge mode additionally requires server-shaped ULID ids — a
  // crafted non-ULID id can no longer land in the DB (audit S3.1).
  const projects = (data.projects as any[])
    .map((p) => ({ raw: p, row: importProjectRow.safeParse(p) }))
    .filter(({ row }) => {
      const ok = row.success && typeof row.data.id === 'string' && (mode === 'duplicate' || isUlid(row.data.id));
      if (!ok) summary.projects.skipped++;
      return ok;
    })
    .map(({ raw, row }) => ({ raw, p: row.success ? row.data : null }));

  const tasks = (data.tasks as any[])
    .map((t) => ({ raw: t, row: importTaskRow.safeParse(t) }))
    .filter(({ row }) => {
      const ok = row.success && (mode === 'duplicate' || isUlid(row.data.id));
      if (!ok) summary.tasks.skipped++;
      return ok;
    })
    .map(({ row }) => ({ t: row.success ? row.data : null }));

  const subtasks = (data.subtasks as any[]).flatMap((s) => {
    const r = importSubtaskRow.safeParse(s);
    if (!r.success) {
      summary.subtasks.skipped++;
      return [];
    }
    return [r.data];
  });

  // Cycle check over the resulting dependency graph — the same reachability
  // rule createDependency enforces, so an import can't corrupt the DAG. Edges
  // are validated incrementally against the user's existing edges + edges
  // accepted from this import; rejected edges are excluded from the insert
  // pass below.
  const acceptedEdges = new Set<string>();
  {
    const existingEdges = (
      await c.env.DB.prepare('SELECT task_id, depends_on_id FROM task_dependencies WHERE user_id = ?1')
        .bind(userId)
        .all<{ task_id: string; depends_on_id: string }>()
    ).results;
    const accepted = [...existingEdges];
    for (const e of accepted) acceptedEdges.add(`${e.task_id}>${e.depends_on_id}`);
    // task graph info for the edge-legality pre-checks (root-only, same project —
    // audit S3.3: the FR-M5 rules the CRUD routes enforce via rules.createDependency)
    const taskInfo = new Map<string, { projectId: string; parentId: string | null }>();
    for (const { t } of tasks) {
      if (!t) continue;
      taskInfo.set(idOf(t.id), { projectId: idOf(t.project_id), parentId: t.parent_id ? idOf(t.parent_id) : null });
    }
    for (const d of data.dependencies as any[]) {
      const parsedDep = importDependencyRow.safeParse(d);
      if (
        !parsedDep.success ||
        !tasks.some((x) => x.t?.id === parsedDep.data.task_id) ||
        !tasks.some((x) => x.t?.id === parsedDep.data.depends_on_id) ||
        parsedDep.data.task_id === parsedDep.data.depends_on_id
      ) {
        summary.dependencies.skipped++;
        continue;
      }
      const edge = { task_id: idOf(parsedDep.data.task_id), depends_on_id: idOf(parsedDep.data.depends_on_id) };
      const a = taskInfo.get(edge.task_id);
      const b = taskInfo.get(edge.depends_on_id);
      // both endpoints must be in-file ROOT tasks of the SAME project
      if (!a || !b || a.parentId || b.parentId || a.projectId !== b.projectId) {
        summary.dependencies.skipped++;
        continue;
      }
      const key = `${edge.task_id}>${edge.depends_on_id}`;
      if (acceptedEdges.has(key)) {
        summary.dependencies.skipped++; // duplicate — INSERT OR IGNORE would skip it too
        continue;
      }
      if (findCyclePath(accepted, edge.task_id, edge.depends_on_id)) {
        summary.dependencies.skipped++; // would close a cycle — drop the edge
        continue;
      }
      accepted.push(edge);
      acceptedEdges.add(key);
    }
  }

  // Import runs as transactional batches, per collection (spec: transaction per project —
  // D1 batch == transaction). Existence checks (for the created/updated summary) run
  // ONCE per collection up front, not per chunk — 20k rows used to pay ~800
  // sequential round-trips (~110 s); now it's collections/200 batches (audit: perf).
  const IMPORT_CHUNK = 200;

  {
    // audit F3 fix #1: a row whose OWN id belongs to another user is skipped
    // (merge mode only — duplicate mode remaps ids, so a foreign own-id cannot
    // occur; references are checked separately below)
    let kept = projects;
    if (mode === 'merge') {
      const foreign = await foreignIds(
        c.env,
        userId,
        'projects',
        projects.map(({ p }) => p!.id),
      );
      if (foreign.size > 0) {
        kept = projects.filter(({ p }) => {
          if (foreign.has(p!.id)) {
            summary.projects.skipped++;
            return false;
          }
          return true;
        });
      }
    }

    // project names: the table keeps its inline UNIQUE(user_id, name), so a
    // duplicate-mode import (same names, new ids) would 500 on every row whose
    // name the account already holds. Per row: the name fits as-is when the
    // only holder is the row ITSELF (a merge re-import updates in place) or
    // the name is free; a DIFFERENT live row holding it → the incoming project
    // is renamed `X (imported)`, `X (imported 2)`, … (deterministic, keeps the
    // whole subtree); a name held by a TOMBSTONE (not being resurrected by an
    // id match) is yielded exactly like the CRUD create route — the tombstone
    // is renamed out of the way.
    const liveHolders = (
      await c.env.DB.prepare('SELECT id, name FROM projects WHERE user_id = ?1 AND deleted_at IS NULL')
        .bind(userId)
        .all<{
          id: string;
          name: string;
        }>()
    ).results;
    const liveByName = new Map(liveHolders.map((h) => [h.name.toUpperCase(), h]));
    const taken = new Set(liveHolders.map((h) => h.name.toUpperCase()));
    const finalNames = new Map<string, string>(); // idOf(row.id) → overridden name
    const keptIds = new Set<string>();
    for (const { p } of kept) {
      const id = idOf(p!.id);
      keptIds.add(id);
      const name = String(p!.name ?? 'Imported');
      const holder = liveByName.get(name.toUpperCase());
      if (holder && holder.id === id) continue; // own row — the upsert keeps the name
      if (!holder && !taken.has(name.toUpperCase())) {
        taken.add(name.toUpperCase()); // free name — first claimant wins it
        continue;
      }
      let candidate = `${name} (imported)`;
      for (let n = 2; taken.has(candidate.toUpperCase()); n++) candidate = `${name} (imported ${n})`;
      finalNames.set(id, candidate.slice(0, LIMITS.nameMax));
      taken.add(candidate.toUpperCase());
    }
    // contested tombstones: rename away in their own batch (same convention as
    // routes/projects.ts create) so the insert fits
    {
      const tombstoneHolders = await c.env.DB.prepare(
        `SELECT id, name FROM projects WHERE user_id = ?1 AND deleted_at IS NOT NULL
         AND name COLLATE NOCASE IN (SELECT value FROM json_each(?2))`,
      )
        .bind(userId, JSON.stringify([...new Set(kept.map(({ p }) => String(p!.name ?? 'Imported')))]))
        .all<{ id: string; name: string }>();
      const yieldStmts = tombstoneHolders.results
        .filter((h) => !keptIds.has(h.id)) // an id match resurrects the row itself — the upsert restores its name
        .map((h) =>
          c.env.DB.prepare(
            `UPDATE projects SET name = name || ' (deleted ' || ?2 || ')', updated_at = ?3
             WHERE user_id = ?1 AND id = ?4 AND deleted_at IS NOT NULL`,
          ).bind(userId, new Date(now).toISOString().slice(0, 10), now, h.id),
        );
      if (yieldStmts.length) await c.env.DB.batch(yieldStmts);
    }

    const allIds = kept.map(({ p }) => idOf(p!.id));
    const exist = await existingIds(c.env, userId, 'projects', allIds);
    for (const batch of chunk(kept, IMPORT_CHUNK)) {
      const stmts = batch.map(({ p }) => {
        const id = idOf(p!.id);
        const isUpdate = exist.has(id);
        if (isUpdate) summary.projects.updated++;
        else summary.projects.created++;
        const name = finalNames.get(id) ?? String(p!.name ?? 'Imported');
        return c.env.DB.prepare(
          `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color,
             archived = excluded.archived, position = excluded.position, updated_at = excluded.updated_at,
             deleted_at = NULL
           WHERE projects.user_id = excluded.user_id`,
        ).bind(
          id,
          userId,
          name.slice(0, LIMITS.nameMax),
          /^#[0-9a-fA-F]{6}$/.test(p!.color ?? '') ? p!.color : '#4f8cff',
          p!.archived,
          p!.position,
          clampTs(p!.created_at),
          now,
        );
      });
      if (stmts.length) await c.env.DB.batch(stmts);
    }
  }

  // tasks that survive planning — subtasks, dependency edges and sessions are
  // only allowed to reference these (a skipped task must not gain dangling
  // children: their FKs would 500 the batch)
  const acceptedTaskIds = new Set<string>();
  {
    // hierarchy pre-pass (audit S3.2/S3.3): a parent must be IN-FILE, ROOT
    // (itself parentless) and in the SAME project — the same two-level rule the
    // task routes enforce (FR-T3)
    //
    // audit F3 fix #2: a task's project must be one that will exist for THIS
    // user afterwards — an in-file project that survived the foreign-id skip,
    // or any project already owned by the caller. (Pre-fix the check was
    // "project_id appears in the file", so a task slid into someone else's
    // project: the project upsert no-oped on the WHERE user_id clause while
    // the task still inserted pointing at it.)
    const referencedProjects = [...new Set(tasks.filter(({ t }) => t).map(({ t }) => idOf(t!.project_id)))];
    const ownedReferencedProjects = await existingIds(c.env, userId, 'projects', referencedProjects);
    const inFileProjectIds = new Set(projects.map(({ p }) => idOf(p!.id)));
    const foreignProjectOwnIds =
      mode === 'merge' ? await foreignIds(c.env, userId, 'projects', [...inFileProjectIds]) : new Set<string>();
    const acceptedProjectIds = new Set<string>([
      ...ownedReferencedProjects,
      ...[...inFileProjectIds].filter((id) => !foreignProjectOwnIds.has(id)),
    ]);

    const plannedTasks = tasks.filter(({ t }) => {
      if (!t) return false;
      if (!acceptedProjectIds.has(idOf(t.project_id))) {
        summary.tasks.skipped++;
        return false;
      }
      return true;
    });
    const byFileId = new Map<string, { id: string; projectId: string; parentId: string | null }>();
    for (const { t } of plannedTasks) {
      const id = idOf(t!.id);
      byFileId.set(t!.id, { id, projectId: t!.project_id, parentId: t!.parent_id ?? null });
    }
    const acceptedTasks = plannedTasks.filter(({ t }) => {
      const self = byFileId.get(t!.id)!;
      if (!self.parentId) return true;
      const parent = byFileId.get(self.parentId);
      if (!parent || parent.parentId || parent.projectId !== self.projectId) {
        summary.tasks.skipped++;
        return false;
      }
      return true;
    });
    for (const { t } of acceptedTasks) acceptedTaskIds.add(idOf(t!.id));
    const exist = await existingIds(
      c.env,
      userId,
      'tasks',
      acceptedTasks.map(({ t }) => idOf(t!.id)),
    );
    for (const batch of chunk(acceptedTasks, IMPORT_CHUNK)) {
      const stmts = batch.map(({ t }) => {
        const id = idOf(t!.id);
        if (exist.has(id)) summary.tasks.updated++;
        else summary.tasks.created++;
        return c.env.DB.prepare(
          `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, parent_id = excluded.parent_id,
             name = excluded.name, notes = excluded.notes, done = excluded.done,
             position = excluded.position, updated_at = excluded.updated_at,
             deleted_at = NULL
           WHERE tasks.user_id = excluded.user_id`,
        ).bind(
          id,
          userId,
          idOf(t!.project_id),
          t!.parent_id ? idOf(t!.parent_id) : null,
          String(t!.name ?? 'Task').slice(0, LIMITS.nameMax),
          String(t!.notes ?? '').slice(0, LIMITS.noteMax),
          t!.done,
          t!.position,
          clampTs(t!.created_at),
          now,
        );
      });
      if (stmts.length) await c.env.DB.batch(stmts);
    }
  }

  {
    const plannedSubs = subtasks.filter((s) => {
      // the task must be an ACCEPTED task (it will exist after the tasks pass
      // above) — a subtask on a skipped task would dangle its FK
      if (!acceptedTaskIds.has(idOf(s.task_id))) {
        summary.subtasks.skipped++;
        return false;
      }
      return true;
    });
    const exist = await existingIds(
      c.env,
      userId,
      'subtasks',
      plannedSubs.map((s) => idOf(s.id)),
    );
    for (const batch of chunk(plannedSubs, IMPORT_CHUNK)) {
      const stmts = batch.map((s) => {
        const id = idOf(s.id);
        if (exist.has(id)) summary.subtasks.updated++;
        else summary.subtasks.created++;
        return c.env.DB.prepare(
          `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (id) DO UPDATE SET task_id = excluded.task_id, name = excluded.name,
             done = excluded.done, position = excluded.position
           WHERE subtasks.user_id = excluded.user_id`,
        ).bind(
          id,
          idOf(s.task_id),
          userId,
          String(s.name ?? 'Subtask').slice(0, LIMITS.nameMax),
          s.done,
          s.position,
          clampTs(s.created_at),
        );
      });
      if (stmts.length) await c.env.DB.batch(stmts);
    }
  }

  {
    // dependency insert pass — everything (membership, root-only, same-project,
    // duplicate, cycle) was already decided by the cycle-check pass above; only
    // accepted edges are inserted
    const depRows = (data.dependencies as any[])
      .map((d) => importDependencyRow.safeParse(d))
      .filter(({ success }) => {
        if (!success) summary.dependencies.skipped++;
        return success;
      })
      .map(({ data: d }) => ({
        task_id: idOf(d!.task_id),
        depends_on_id: idOf(d!.depends_on_id),
        created_at: d!.created_at,
      }))
      .filter((e) => {
        if (!acceptedEdges.has(`${e.task_id}>${e.depends_on_id}`)) return false; // counted above
        // both endpoints must have SURVIVED planning — an edge on a skipped
        // task would violate the FK (a pre-fix import could 500 here)
        if (!acceptedTaskIds.has(e.task_id) || !acceptedTaskIds.has(e.depends_on_id)) {
          summary.dependencies.skipped++;
          return false;
        }
        return true;
      });
    for (const batch of chunk(depRows, IMPORT_CHUNK)) {
      const stmts = batch.map((e) =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, user_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
        ).bind(e.task_id, e.depends_on_id, userId, clampTs(e.created_at)),
      );
      if (stmts.length) {
        await c.env.DB.batch(stmts);
        summary.dependencies.created += stmts.length;
      }
    }
  }

  {
    const plannedSessions = (data.sessions as any[])
      .map((s) => importSessionRow.safeParse(s))
      .filter(({ success }) => {
        if (!success) summary.sessions.skipped++;
        return success;
      })
      .map(({ data: s }) => ({ s: s!, started: s!.started_at, ended: s!.ended_at }))
      .filter(({ started, ended }) => {
        // closed interval + future tolerance, matching the session-create rules
        // (an open-ended row can't import — it would collide with idx_sessions_running)
        if (ended === null || ended <= started || started > now + SESSION_RULES.futureToleranceMs) {
          summary.sessions.skipped++;
          return false;
        }
        return true;
      });

    // audit F3 fix #1: a row whose own id belongs to another user is skipped
    // (merge mode; duplicate mode remaps ids)
    let candidateSessions = plannedSessions;
    if (mode === 'merge') {
      const foreign = await foreignIds(
        c.env,
        userId,
        'time_sessions',
        plannedSessions.map(({ s }) => s.id),
      );
      if (foreign.size > 0) {
        candidateSessions = plannedSessions.filter(({ s }) => {
          if (foreign.has(s.id)) {
            summary.sessions.skipped++;
            return false;
          }
          return true;
        });
      }
    }

    // audit F3 fix #3: every session's task must be one this user may track on
    // — the same rule POST /sessions enforces (routes/sessions.ts:128-137):
    // the caller's own task (any tombstone state — an import may restore one's
    // own history; the upsert clears deleted_at) or a LIVE task of a group
    // project the caller is a member of. Set-based: one query per 90 refs.
    // (The create path's archived gate is deliberately absent: archived
    // history must round-trip — that gate is timer UX, not ownership.)
    // audit F3 fix #3: every session's task must be one this user may track on
    // — the same rule POST /sessions enforces (routes/sessions.ts:128-137):
    // the caller's own task (any tombstone state — an import may restore one's
    // own history; the upsert clears deleted_at) or a LIVE task of a group
    // project the caller is a member of. Set-based: one query per 90 refs.
    // (The create path's archived gate is deliberately absent: archived
    // history must round-trip — that gate is timer UX, not ownership.)
    const outOfFileRefs = [
      ...new Set(candidateSessions.map(({ s }) => idOf(s.task_id)).filter((id) => !acceptedTaskIds.has(id))),
    ];
    const accessibleTasks = new Set<string>();
    for (const part of chunk(outOfFileRefs, 90)) {
      if (part.length === 0) continue;
      const marks = part.map((_, k) => `?${k + 2}`).join(',');
      const rows = await c.env.DB.prepare(
        `SELECT id FROM tasks WHERE id IN (${marks}) AND user_id = ?1
         UNION
         SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id IN (${marks}) AND t.deleted_at IS NULL AND p.deleted_at IS NULL
           AND p.group_id IS NOT NULL
           AND p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1)`,
      )
        .bind(userId, ...part)
        .all<{ id: string }>();
      for (const r of rows.results) accessibleTasks.add(r.id);
    }
    // a session's task is acceptable when it is in-file-accepted or resolved
    // accessible above; the rest are counted here — pre-fix they inserted and
    // leaked the task name
    const planned = candidateSessions.filter(({ s }) => {
      const ref = idOf(s.task_id);
      return acceptedTaskIds.has(ref) || accessibleTasks.has(ref);
    });
    summary.sessions.skipped += candidateSessions.length - planned.length;

    const exist = await existingIds(
      c.env,
      userId,
      'time_sessions',
      planned.map(({ s }) => idOf(s.id)),
    );
    // subtask links survive import only when the subtask exists AND belongs to
    // the session's task (subtasks import first; a skipped row → link drops,
    // the session's time still imports)
    const importSubIds = planned.filter(({ s }) => s.subtask_id).map(({ s }) => s.subtask_id!);
    const importSubs = new Map<string, string>();
    for (const batch of chunk(importSubIds, 90)) {
      const marks = batch.map((_, k) => `?${k + 2}`).join(',');
      const rows = await c.env.DB.prepare(`SELECT id, task_id FROM subtasks WHERE user_id = ?1 AND id IN (${marks})`)
        .bind(userId, ...batch)
        .all<{ id: string; task_id: string }>();
      for (const r of rows.results) importSubs.set(r.id, r.task_id);
    }
    for (const batch of chunk(planned, IMPORT_CHUNK)) {
      // audit F3 fix #4, scoped to what import must actually prevent: a
      // repeated merge/duplicate re-importing the same ranges under fresh ids
      // (the double-count scenario) — an EXACT same-task/same-range row is
      // skipped. The full sessions.ts overlap predicate deliberately NOT used:
      // /timer/start (the DO) enforces only the single-RUNNING invariant, so
      // production data legitimately contains PARTIAL and even CONTAINED
      // overlaps (a timer started and stopped inside a future-dated manual
      // entry — e2e/roundtrip-test.mjs holds exactly that fixture), and a
      // restore must never silently drop that time (FR-D1: import is
      // identity-preserving). Overlaps beyond the exact signature are
      // self-inflicted (import is user-scoped) and restore faithfully.
      // `id <> ?1` lets a row update itself; a guard-blocked row reports
      // changes 0 and is counted as skipped below (wroteOne discipline —
      // never trust the planned count).
      const pairs = batch.map(({ s, started, ended }) => {
        const id = idOf(s.id);
        const sub = s.subtask_id && importSubs.get(s.subtask_id) === idOf(s.task_id) ? s.subtask_id : null;
        const stmt = c.env.DB.prepare(
          // task_name keeps the historical name in step with the task (INV-06);
          // post-ownership-check it can only copy from an own/accessible task
          `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at, subtask_id, task_name)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, (SELECT name FROM tasks WHERE id = ?3)
           WHERE NOT EXISTS (
             SELECT 1 FROM time_sessions
             WHERE task_id = ?3 AND user_id = ?2 AND id <> ?1
               AND started_at = ?4 AND ended_at IS ?5
           )
           ON CONFLICT (id) DO UPDATE SET task_id = excluded.task_id, started_at = excluded.started_at,
             ended_at = excluded.ended_at, note = excluded.note, updated_at = excluded.updated_at,
             task_name = excluded.task_name
           WHERE time_sessions.user_id = excluded.user_id`,
        ).bind(
          id,
          userId,
          idOf(s.task_id),
          started,
          ended,
          s.source,
          String(s.note ?? '').slice(0, LIMITS.noteMax),
          clampTs(s.created_at),
          sub,
        );
        return { id, stmt };
      });
      if (pairs.length) {
        const results = await c.env.DB.batch(pairs.map(({ stmt }) => stmt));
        for (let i = 0; i < pairs.length; i++) {
          if (!wroteOne(results[i])) {
            summary.sessions.skipped++; // overlap-blocked (or raced away) — never counted as written
            continue;
          }
          if (exist.has(pairs[i]!.id)) summary.sessions.updated++;
          else summary.sessions.created++;
        }
      }
    }
  }

  // ---------- goals (audit F19) ----------
  {
    const parsedGoals = (data.goals as any[])
      .map((g) => importGoalRow.safeParse(g))
      .filter(({ success }) => {
        if (!success) summary.goals.skipped++;
        return success;
      })
      .map(({ data: g }) => g!);

    // audit F3 fix #1 for goals: a row whose own id belongs to another user is
    // skipped (merge mode; duplicate mode remaps ids)
    let candidates = parsedGoals;
    if (mode === 'merge') {
      const foreign = await foreignIds(
        c.env,
        userId,
        'goals',
        parsedGoals.map((g) => g.id),
      );
      if (foreign.size > 0) {
        candidates = parsedGoals.filter((g) => {
          if (foreign.has(g.id)) {
            summary.goals.skipped++;
            return false;
          }
          return true;
        });
      }
    }

    // duplicate mode: remap the goal's own id AND its scope refs onto the
    // duplicated entities (a ref to an id outside the file stays as-is — it
    // either points at an owned node or is caught by the scope check below)
    const prepared = candidates.map((g) => {
      if (mode === 'duplicate') {
        return {
          ...g,
          id: idOf(g.id),
          scope: g.scope.map((ref) => {
            const idx = ref.indexOf(':');
            return `${ref.slice(0, idx + 1)}${idOf(ref.slice(idx + 1))}`;
          }),
        };
      }
      return g;
    });

    // every scope ref must resolve to a live, accessible node (the same rule
    // POST /goals enforces, goals.ts assertScopeAccessible) — the goals pass
    // runs AFTER the tasks pass, so refs to in-file tasks see their upserted
    // (resurrected) rows; an unreachable ref skips the whole goal
    const acceptedGoals: typeof prepared = [];
    for (const g of prepared) {
      try {
        await assertScopeAccessible(c.env, userId, g.scope);
        acceptedGoals.push(g);
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        summary.goals.skipped++;
      }
    }

    const exist = await existingIds(
      c.env,
      userId,
      'goals',
      acceptedGoals.map((g) => g.id),
    );
    for (const batch of chunk(acceptedGoals, IMPORT_CHUNK)) {
      // the per-user cap lives INSIDE the statement (audit 🟡2 rule) — but an
      // own-id row bypasses the cap: it is an update of an existing goal
      const stmts = batch.map((g) =>
        c.env.DB.prepare(
          `INSERT INTO goals (id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           WHERE (SELECT COUNT(*) FROM goals WHERE user_id = ?2) < ?11
              OR EXISTS (SELECT 1 FROM goals WHERE id = ?1 AND user_id = ?2)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, period = excluded.period,
             direction = excluded.direction, target_minutes = excluded.target_minutes,
             scope = excluded.scope, ends_at = excluded.ends_at, archived_at = excluded.archived_at
           WHERE goals.user_id = excluded.user_id`,
        ).bind(
          g.id,
          userId,
          g.name.slice(0, LIMITS.goalNameMax),
          g.period,
          g.direction,
          g.target_minutes,
          JSON.stringify(g.scope),
          g.ends_at,
          clampTs(g.created_at),
          g.archived_at === null ? null : clampTs(g.archived_at),
          LIMITS.goalsPerUser,
        ),
      );
      const results = await c.env.DB.batch(stmts);
      for (let i = 0; i < batch.length; i++) {
        if (!wroteOne(results[i])) {
          summary.goals.skipped++; // at the per-user cap (or a raced foreign id)
          continue;
        }
        if (exist.has(batch[i]!.id)) summary.goals.updated++;
        else summary.goals.created++;
      }
    }
  }

  // apply imported settings (the import schema accepts them)
  if (data.settings) {
    const ps = settingsSchema.safeParse(data.settings);
    if (ps.success) {
      const row = await c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
        .bind(userId)
        .first<{ data: string }>();
      const current = mergeSettings(row?.data);
      const s = ps.data;
      const next = {
        ...current,
        ...(s.pomodoro ? { pomodoro: { ...current.pomodoro, ...s.pomodoro } } : {}),
        ...(s.grace_min !== undefined ? { grace_min: s.grace_min } : {}),
        ...(s.notifications_enabled !== undefined ? { notifications_enabled: s.notifications_enabled } : {}),
        ...(s.sound_enabled !== undefined ? { sound_enabled: s.sound_enabled } : {}),
        ...(s.theme !== undefined ? { theme: s.theme } : {}),
      };
      // settings + profile theme mirror in ONE batch (audit: the PUT /settings
      // path does the same — a crash between them used to leave them divergent)
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO settings (user_id, data) VALUES (?1, ?2)
           ON CONFLICT (user_id) DO UPDATE SET data = excluded.data`,
        ).bind(userId, JSON.stringify(next)),
        ...(s.theme !== undefined
          ? [c.env.DB.prepare('UPDATE users SET theme = ?1, updated_at = ?2 WHERE id = ?3').bind(s.theme, now, userId)]
          : []),
      ]);
    }
  }

  // Other devices learn about the import; clients react to this event with a
  // full refetch (store.applyEvent).
  //
  // import.completed CANNOT share a batch with the imported rows: the import is
  // chunked into many batches (200 rows each, up to 200k sessions), and the
  // event means "the whole import finished" — it is only true once every chunk
  // has. So this is the one deliberate exception to INV-11 in the import path.
  // EVENT-ATOMICITY-ALLOWED — the SAFE shape: the event is a completion signal,
  // not a record of a single entity write, and clients treat it by refetching
  // everything. The
  // client that loses the event sees stale data until its next reload, not a
  // partial import. The per-entity invariants (overlap, caps) are unaffected —
  // they live inside the import's own statements.
  const drafts: EventDraft[] = [{ type: 'import.completed', actor: c.get('deviceId'), data: { mode, summary } }];
  const evs = await appendEvents(c.env, userId, drafts);
  notifyHub(c.env, userId, evs, c.executionCtx);

  return c.json({ ok: true, mode, summary, events: evs });
});

// ---------- restore (undo payload target, FR-T4) ----------

exportRoutes.post('/restore', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > IMPORT_BODY_MAX_BYTES) return jsonError(413, 'too_large', 'restore payload too large');
  const userId = c.get('user').id;
  const parsed = restoreSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid restore payload', parsed.error.flatten());
  const d = parsed.data;
  const now = Date.now();
  let restored = 0;

  // Chunked batches with per-chunk ownership pre-checks — sequential per-row
  // .run() round-trips could easily outlast the 5-second undo toast.
  // Rows are schema-validated (restoreSchema) and cross-row rules re-checked
  // here: a mutated/crafted undo payload gets the same hierarchy/duration
  // invariants as the import path (audit S3) instead of 500s or bad rows.

  /** created_at is preserved for undo fidelity, but clamped to [0, now] (audit S3.6). */
  const clampTs = (v: number): number => (v > 0 ? Math.min(v, now) : now);
  const safePos = (v: number): number => (Number.isFinite(v) ? v : 0);

  for (const batch of chunk(d.projects, 50)) {
    const stmts = batch
      .filter((p) => isUlid(p.id))
      .map((p) =>
        c.env.DB.prepare(
          `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET archived = 0, updated_at = excluded.updated_at,
           deleted_at = NULL
         WHERE projects.user_id = excluded.user_id`,
        ).bind(
          p.id,
          userId,
          String(p.name ?? 'Restored').slice(0, LIMITS.nameMax),
          /^#[0-9a-fA-F]{6}$/.test(p.color ?? '') ? p.color : '#4f8cff',
          p.archived,
          safePos(p.position),
          clampTs(p.created_at),
          now,
        ),
      );
    if (stmts.length) {
      await c.env.DB.batch(stmts);
      restored += stmts.length;
    }
  }

  // tasks: parent must be a root task of the SAME project within the payload
  // (audit S3.2 — a crafted 3-level payload must not land)
  {
    const payloadById = new Map(d.tasks.map((t) => [t.id, t]));
    const valid = d.tasks.filter(
      (t) =>
        isUlid(t.id) &&
        typeof t.project_id === 'string' &&
        (!t.parent_id ||
          (payloadById.get(t.parent_id) !== undefined && payloadById.get(t.parent_id)!.parent_id === null)),
    );
    if (!valid.length) {
      /* skip */
    } else {
      const ownedProjects = await existingIds(
        c.env,
        userId,
        'projects',
        valid.map((t) => t.project_id),
      );
      // same-project parent check (project of parent row == project of child)
      const stmts = valid
        .filter(
          (t) =>
            ownedProjects.has(t.project_id) &&
            (!t.parent_id || payloadById.get(t.parent_id)!.project_id === t.project_id),
        )
        .map((t) =>
          c.env.DB.prepare(
            `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
             deleted_at = NULL
           WHERE tasks.user_id = excluded.user_id`,
          ).bind(
            t.id,
            userId,
            t.project_id,
            t.parent_id ?? null,
            String(t.name ?? 'Task').slice(0, LIMITS.nameMax),
            String(t.notes ?? '').slice(0, LIMITS.noteMax),
            t.done,
            safePos(t.position),
            clampTs(t.created_at),
            now,
          ),
        );
      if (stmts.length) {
        await c.env.DB.batch(stmts);
        restored += stmts.length;
      }
    }
  }

  for (const batch of chunk(d.subtasks, 50)) {
    const valid = batch.filter((s) => isUlid(s.id) && typeof s.task_id === 'string');
    if (!valid.length) continue;
    const ownedTasks = await existingIds(
      c.env,
      userId,
      'tasks',
      valid.map((s) => s.task_id),
    );
    const stmts = valid
      .filter((s) => ownedTasks.has(s.task_id))
      .map((s) =>
        c.env.DB.prepare(
          `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET done = excluded.done, name = excluded.name
         WHERE subtasks.user_id = excluded.user_id`,
        ).bind(
          s.id,
          s.task_id,
          userId,
          String(s.name ?? 'Subtask').slice(0, LIMITS.nameMax),
          s.done,
          safePos(s.position),
          clampTs(s.created_at),
        ),
      );
    if (stmts.length) {
      await c.env.DB.batch(stmts);
      restored += stmts.length;
    }
  }

  for (const batch of chunk(d.dependencies, 50)) {
    const valid = batch.filter(
      (dep) => isUlid(dep.task_id) && isUlid(dep.depends_on_id) && dep.task_id !== dep.depends_on_id,
    );
    if (!valid.length) continue;
    // both endpoints must belong to the caller — dependency rows pointing at
    // other users' tasks are rejected
    const ownedTasks = await existingIds(
      c.env,
      userId,
      'tasks',
      valid.flatMap((dep) => [dep.task_id, dep.depends_on_id]),
    );
    const candidates = valid.filter((dep) => ownedTasks.has(dep.task_id) && ownedTasks.has(dep.depends_on_id));
    if (!candidates.length) continue;
    // FR-M5 parity (audit S3.3): edges may only connect root tasks of the same
    // project — verified against the actual DB rows (endpoints may be
    // pre-existing tasks, not just payload rows)
    const info = new Map<string, { project_id: string; parent_id: string | null }>();
    for (const part of chunk(
      candidates.flatMap((dep) => [dep.task_id, dep.depends_on_id]),
      90,
    )) {
      const marks = part.map((_, k) => `?${k + 2}`).join(',');
      const rows = await c.env.DB.prepare(
        `SELECT id, project_id, parent_id FROM tasks WHERE user_id = ?1 AND id IN (${marks})`,
      )
        .bind(userId, ...part)
        .all<{ id: string; project_id: string; parent_id: string | null }>();
      for (const r of rows.results) info.set(r.id, r);
    }
    const stmts = candidates
      .filter((dep) => {
        const a = info.get(dep.task_id);
        const b = info.get(dep.depends_on_id);
        return a && b && a.parent_id === null && b.parent_id === null && a.project_id === b.project_id;
      })
      .map((dep) =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, user_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
        ).bind(dep.task_id, dep.depends_on_id, userId, clampTs(dep.created_at)),
      );
    if (stmts.length) {
      await c.env.DB.batch(stmts);
      restored += stmts.length;
    }
  }

  for (const batch of chunk(d.sessions, 50)) {
    const planned = [];
    for (const s of batch) {
      if (!isUlid(s.id) || typeof s.task_id !== 'string') continue;
      const started = s.started_at; // schema-guaranteed finite int
      // audit S3.4: an open session (ended_at NULL — the deleted task was
      // running) re-closes at restore-time; a mutated payload with
      // ended_at < started_at is rejected instead of restoring a negative duration
      const ended = s.ended_at ?? now;
      if (ended <= started) continue;
      planned.push({ s, started, ended });
    }
    if (!planned.length) continue;
    const ownedTasks = await existingIds(
      c.env,
      userId,
      'tasks',
      planned.map((p) => p.s.task_id),
    );
    // a subtask link survives restore only when the subtask exists AND belongs
    // to the session's task (subtasks restore earlier in this handler; a
    // dropped link must NOT abort the batch — the time is the precious part)
    const restoreSubIds = planned.filter(({ s }) => s.subtask_id).map(({ s }) => s.subtask_id!);
    const restoreSubs = new Map<string, string>();
    for (const part of chunk(restoreSubIds, 90)) {
      const marks = part.map((_, k) => `?${k + 2}`).join(',');
      const rows = await c.env.DB.prepare(`SELECT id, task_id FROM subtasks WHERE user_id = ?1 AND id IN (${marks})`)
        .bind(userId, ...part)
        .all<{ id: string; task_id: string }>();
      for (const r of rows.results) restoreSubs.set(r.id, r.task_id);
    }
    const stmts = planned
      .filter(({ s }) => ownedTasks.has(s.task_id))
      .map(({ s, started, ended }) => {
        const sub = s.subtask_id && restoreSubs.get(s.subtask_id) === s.task_id ? s.subtask_id : null;
        return c.env.DB.prepare(
          `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at, subtask_id, task_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, (SELECT name FROM tasks WHERE id = ?3))
           ON CONFLICT (id) DO NOTHING`,
        ).bind(
          s.id,
          userId,
          s.task_id,
          started,
          ended,
          s.source,
          String(s.note ?? '').slice(0, LIMITS.noteMax),
          now,
          sub,
        );
      });
    if (stmts.length) {
      await c.env.DB.batch(stmts);
      restored += stmts.length;
    }
  }

  // Other devices learn about the undo — clients react with a full refetch
  // (audit: restore used to fan out nothing, silently diverging other devices).
  // Like import.completed, this is a completion signal for a multi-batch
  // operation, so it cannot share a batch with the restored rows (see the note
  // at import.completed).
  const evs = await appendEvents(c.env, userId, [
    { type: 'restore.completed', actor: c.get('deviceId'), data: { restored } },
  ] as EventDraft[]);
  notifyHub(c.env, userId, evs, c.executionCtx);

  return c.json({ ok: true, restored, events: evs });
});
