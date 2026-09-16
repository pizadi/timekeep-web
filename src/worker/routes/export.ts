// FR-D1/D2: data portability — inline JSON/CSV export, import (merge-by-id upsert
// or duplicate-with-new-ids), and the restore endpoint backing the 5-second
// undo toasts (FR-T4: "undo restores the identical row", ids preserved).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy } from '../middleware';
import { importSchema, restoreSchema } from '../validators';
import { ulid, isUlid } from '../../shared/ids';
import { EXPORT_SCHEMA_VERSION, LIMITS } from '../../shared/constants';

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

  const [user, settingsRow, projects, tasks, subtasks, deps, sessions] = await Promise.all([
    c.env.DB.prepare('SELECT id, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start, theme, created_at FROM users WHERE id = ?1').bind(userId).first(),
    c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1').bind(userId).first<{ data: string }>(),
    c.env.DB.prepare('SELECT * FROM projects WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM tasks WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM subtasks WHERE user_id = ?1 ORDER BY position').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM task_dependencies WHERE user_id = ?1').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM time_sessions WHERE user_id = ?1 ORDER BY started_at').bind(userId).all()
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
    const taskName = new Map((tasks.results as any[]).map((t) => [t.id, t.name]));
    const projName = new Map((projects.results as any[]).map((p) => [p.id, p.name]));
    for (const s of rows) {
      const mins = Math.round(((s.ended_at ?? Date.now()) - s.started_at) / 60000);
      lines.push([
        esc(csvSafe(projName.get((tasks.results as any[]).find((t: any) => t.id === s.task_id)?.project_id))),
        esc(csvSafe(taskName.get(s.task_id))),
        new Date(s.started_at).toISOString(),
        s.ended_at ? new Date(s.ended_at).toISOString() : '',
        String(mins), esc(csvSafe(s.source)), esc(csvSafe(s.note))
      ].join(','));
    }
    return new Response(lines.join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="timekeep-sessions.csv"`
      }
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
    sessions: sessions.results
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="timekeep-export.json"`
    }
  });
});

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

// ---------- import (FR-D2) ----------

exportRoutes.post('/import', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const parsed = await importSchema.safeParseAsync(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid import payload', parsed.error.flatten());
  const { mode, data } = parsed.data;
  const now = Date.now();
  const summary = { projects: { created: 0, updated: 0, skipped: 0 }, tasks: { created: 0, updated: 0, skipped: 0 }, subtasks: { created: 0, updated: 0, skipped: 0 }, dependencies: { created: 0, updated: 0, skipped: 0 }, sessions: { created: 0, updated: 0, skipped: 0 } };

  // duplicate mode: remap every id to a fresh one (project → task → subtask → dep → session)
  const map = new Map<string, string>();
  if (mode === 'duplicate') {
    for (const coll of [data.projects, data.tasks, data.subtasks, data.sessions]) {
      for (const row of coll) if (row?.id && typeof row.id === 'string') map.set(row.id, ulid(now + map.size));
    }
  }
  const idOf = (ref: unknown): string =>
    mode === 'duplicate' && typeof ref === 'string' && map.has(ref) ? map.get(ref)! : (ref as string);

  // Import runs as transactional batches, per collection (spec: transaction per project —
  // D1 batch == transaction; we batch per collection chunk to stay under statement limits).
  const chunk = <T>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  const count = async (sql: string): Promise<number> =>
    Number((await c.env.DB.prepare(sql).bind(userId).first<{ n: number }>())?.n ?? 0);

  for (const batch of chunk(data.projects as any[], 50)) {
    const stmts = batch.map((p) => {
      const id = idOf(p.id);
      return c.env.DB.prepare(
        `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color,
           archived = excluded.archived, position = excluded.position, updated_at = excluded.updated_at
         WHERE projects.user_id = excluded.user_id`
      ).bind(id, userId, String(p.name ?? 'Imported').slice(0, LIMITS.nameMax),
        /^#[0-9a-fA-F]{6}$/.test(p.color ?? '') ? p.color : '#4f8cff',
        p.archived ? 1 : 0, Number(p.position ?? 0), Number(p.created_at ?? now), now);
    });
    await c.env.DB.batch(stmts);
    summary.projects.created += batch.length;
  }

  for (const batch of chunk(data.tasks as any[], 50)) {
    const stmts = [];
    for (const t of batch) {
      const id = idOf(t.id);
      const projectId = idOf(t.project_id);
      const parentOk = !t.parent_id || data.tasks.some((x: any) => x.id === t.parent_id);
      const projectOk = data.projects.some((x: any) => x.id === t.project_id);
      if (!projectOk || !parentOk) { summary.tasks.skipped++; continue; }
      stmts.push(c.env.DB.prepare(
        `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, parent_id = excluded.parent_id,
           name = excluded.name, notes = excluded.notes, done = excluded.done,
           position = excluded.position, updated_at = excluded.updated_at
         WHERE tasks.user_id = excluded.user_id`
      ).bind(id, userId, projectId, t.parent_id ? idOf(t.parent_id) : null,
        String(t.name ?? 'Task').slice(0, LIMITS.nameMax), String(t.notes ?? '').slice(0, LIMITS.noteMax),
        t.done ? 1 : 0, Number(t.position ?? 0), Number(t.created_at ?? now), now));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    summary.tasks.created += stmts.length;
  }

  for (const batch of chunk(data.subtasks as any[], 50)) {
    const stmts = [];
    for (const s of batch) {
      if (!data.tasks.some((x: any) => x.id === s.task_id)) { summary.subtasks.skipped++; continue; }
      stmts.push(c.env.DB.prepare(
        `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET task_id = excluded.task_id, name = excluded.name,
           done = excluded.done, position = excluded.position
         WHERE subtasks.user_id = excluded.user_id`
      ).bind(idOf(s.id), idOf(s.task_id), userId, String(s.name ?? 'Subtask').slice(0, LIMITS.nameMax),
        s.done ? 1 : 0, Number(s.position ?? 0), Number(s.created_at ?? now)));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    summary.subtasks.created += stmts.length;
  }

  for (const batch of chunk(data.dependencies as any[], 50)) {
    const stmts = [];
    for (const d of batch) {
      if (!data.tasks.some((x: any) => x.id === d.task_id) || !data.tasks.some((x: any) => x.id === d.depends_on_id)
        || d.task_id === d.depends_on_id) { summary.dependencies.skipped++; continue; }
      stmts.push(c.env.DB.prepare(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, user_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`
      ).bind(idOf(d.task_id), idOf(d.depends_on_id), userId, Number(d.created_at ?? now)));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    summary.dependencies.created += stmts.length;
  }

  for (const batch of chunk(data.sessions as any[], 50)) {
    const stmts = [];
    for (const s of batch) {
      if (!data.tasks.some((x: any) => x.id === s.task_id)) { summary.sessions.skipped++; continue; }
      if (!Number.isFinite(Number(s.started_at))) { summary.sessions.skipped++; continue; }
      stmts.push(c.env.DB.prepare(
        `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (id) DO UPDATE SET task_id = excluded.task_id, started_at = excluded.started_at,
           ended_at = excluded.ended_at, note = excluded.note, updated_at = excluded.updated_at
         WHERE time_sessions.user_id = excluded.user_id`
      ).bind(idOf(s.id), userId, idOf(s.task_id), Number(s.started_at),
        s.ended_at == null ? null : Number(s.ended_at),
        ['timer', 'manual', 'pomodoro'].includes(s.source) ? s.source : 'manual',
        String(s.note ?? '').slice(0, LIMITS.noteMax), now));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    summary.sessions.created += stmts.length;
  }

  return c.json({ ok: true, mode, summary });
});

// ---------- restore (undo payload target, FR-T4) ----------

exportRoutes.post('/restore', async (c) => {
  const userId = c.get('user').id;
  const parsed = restoreSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid restore payload', parsed.error.flatten());
  const d = parsed.data;
  const now = Date.now();
  let restored = 0;

  for (const p of d.projects) {
    if (typeof p?.id !== 'string' || !isUlid(p.id)) continue;
    await c.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET archived = 0, updated_at = excluded.updated_at
       WHERE projects.user_id = excluded.user_id`
    ).bind(p.id, userId, String(p.name ?? 'Restored').slice(0, LIMITS.nameMax),
      /^#[0-9a-fA-F]{6}$/.test(p.color ?? '') ? p.color : '#4f8cff',
      p.archived ? 1 : 0, Number(p.position ?? 0), Number(p.created_at ?? now), now).run();
    restored++;
  }
  for (const t of d.tasks) {
    if (typeof t?.id !== 'string' || !isUlid(t.id)) continue;
    const proj = await c.env.DB.prepare('SELECT 1 FROM projects WHERE id = ?1 AND user_id = ?2')
      .bind(t.project_id, userId).first();
    if (!proj) continue;
    await c.env.DB.prepare(
      `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
       WHERE tasks.user_id = excluded.user_id`
    ).bind(t.id, userId, t.project_id, t.parent_id ?? null,
      String(t.name ?? 'Task').slice(0, LIMITS.nameMax), String(t.notes ?? '').slice(0, LIMITS.noteMax),
      t.done ? 1 : 0, Number(t.position ?? 0), Number(t.created_at ?? now), now).run();
    restored++;
  }
  for (const s of d.subtasks) {
    if (typeof s?.id !== 'string' || !isUlid(s.id)) continue;
    const task = await c.env.DB.prepare('SELECT 1 FROM tasks WHERE id = ?1 AND user_id = ?2')
      .bind(s.task_id, userId).first();
    if (!task) continue;
    await c.env.DB.prepare(
      `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET done = excluded.done, name = excluded.name
       WHERE subtasks.user_id = excluded.user_id`
    ).bind(s.id, s.task_id, userId, String(s.name ?? 'Subtask').slice(0, LIMITS.nameMax),
      s.done ? 1 : 0, Number(s.position ?? 0), Number(s.created_at ?? now)).run();
    restored++;
  }
  for (const dep of d.dependencies) {
    if (typeof dep?.task_id !== 'string' || typeof dep?.depends_on_id !== 'string') continue;
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, user_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(dep.task_id, dep.depends_on_id, userId, Number(dep.created_at ?? now)).run();
    restored++;
  }
  for (const s of d.sessions) {
    if (typeof s?.id !== 'string' || !isUlid(s.id) || !Number.isFinite(Number(s.started_at))) continue;
    const task = await c.env.DB.prepare('SELECT 1 FROM tasks WHERE id = ?1 AND user_id = ?2')
      .bind(s.task_id, userId).first();
    if (!task) continue;
    await c.env.DB.prepare(
      `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (id) DO NOTHING`
    ).bind(s.id, userId, s.task_id, Number(s.started_at),
      s.ended_at == null ? null : Number(s.ended_at),
      ['timer', 'manual', 'pomodoro'].includes(s.source) ? s.source : 'manual',
      String(s.note ?? '').slice(0, LIMITS.noteMax), now).run();
    restored++;
  }

  return c.json({ ok: true, restored });
});
