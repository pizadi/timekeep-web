// Bootstrap (one-shot initial state), settings (FR-C), layout persistence (FR-M8),
// sync delta (FR-N3/N5), version (NFR-9).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy } from '../middleware';
import { settingsSchema, layoutSchema } from '../validators';
import { appendEvents, notifyHub } from '../events';
import { DEFAULT_SETTINGS } from '../defaults';

export const miscRoutes = new Hono<WorkerType>();

// ---------- public config (pre-auth: Turnstile widget needs the site key) ----------
miscRoutes.get('/config', (c) => c.json({ turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null }));

// ---------- bootstrap ----------
miscRoutes.get('/bootstrap', requireAuth, async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const [projects, tasks, subtasks, deps, settingsRow, hubState] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, name, color, archived, position, created_at, updated_at FROM projects WHERE user_id = ?1 ORDER BY position, created_at'
    ).bind(userId).all(),
    c.env.DB.prepare(
      'SELECT * FROM tasks WHERE user_id = ?1 ORDER BY position, created_at'
    ).bind(userId).all(),
    c.env.DB.prepare(
      'SELECT * FROM subtasks WHERE user_id = ?1 ORDER BY position, created_at'
    ).bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM task_dependencies WHERE user_id = ?1').bind(userId).all(),
    c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1').bind(userId).first<{ data: string }>(),
    (async () => {
      try {
        const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
        const res = await stub.fetch(new Request('https://do/state', { headers: { 'x-internal': '1' } }));
        return res.ok ? await res.json() : { session: null, pomo: null };
      } catch {
        return { session: null, pomo: null };
      }
    })()
  ]);

  return c.json({
    user: c.get('user'),
    settings: mergeSettings(settingsRow?.data),
    projects: projects.results,
    tasks: tasks.results,
    subtasks: subtasks.results,
    dependencies: deps.results,
    running: (hubState as any).session ?? null,
    pomo: (hubState as any).pomo ?? null,
    last_event_id: (hubState as any).last_event_id ?? 0,
    devices: (hubState as any).devices ?? 0,
    server_now: Date.now()
  });
});

function mergeSettings(raw?: string) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------- settings (FR-C1: server-validated, syncs everywhere) ----------
miscRoutes.get('/settings', requireAuth, async (c) => {
  const row = await c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
    .bind(c.get('user').id).first<{ data: string }>();
  return c.json({ settings: mergeSettings(row?.data), turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null });
});

miscRoutes.put('/settings', requireAuth, async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid settings payload', parsed.error.flatten());

  const row = await c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
    .bind(c.get('user').id).first<{ data: string }>();
  const current = mergeSettings(row?.data);
  const next = {
    ...current,
    ...(parsed.data.pomodoro ? { pomodoro: { ...current.pomodoro, ...parsed.data.pomodoro } } : {}),
    ...(parsed.data.grace_min !== undefined ? { grace_min: parsed.data.grace_min } : {}),
    ...(parsed.data.notifications_enabled !== undefined ? { notifications_enabled: parsed.data.notifications_enabled } : {}),
    ...(parsed.data.sound_enabled !== undefined ? { sound_enabled: parsed.data.sound_enabled } : {}),
    ...(parsed.data.theme !== undefined ? { theme: parsed.data.theme } : {})
  };
  // keep theme mirrored on the profile for server-side persistence (FR-U1)
  if (parsed.data.theme !== undefined) {
    await c.env.DB.prepare('UPDATE users SET theme = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(parsed.data.theme, Date.now(), c.get('user').id).run();
  }
  await c.env.DB.prepare(
    `INSERT INTO settings (user_id, data) VALUES (?1, ?2)
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data`
  ).bind(c.get('user').id, JSON.stringify(next)).run();

  const evs = await appendEvents(c.env, c.get('user').id,
    [{ type: 'settings.updated', actor: c.get('deviceId'), data: { settings: next } }]);
  notifyHub(c.env, c.get('user').id, evs);
  return c.json({ settings: next, events: evs });
});

// ---------- map layout (FR-M8) ----------
miscRoutes.get('/layout/:projectId', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.task_id, l.x, l.y FROM layout l
     JOIN tasks t ON t.id = l.task_id
     WHERE l.user_id = ?1 AND t.project_id = ?2`
  ).bind(c.get('user').id, c.req.param('projectId')).all();
  return c.json({ positions: rows.results });
});

miscRoutes.put('/layout/:projectId', requireAuth, async (c) => {
  const parsed = layoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid layout payload', parsed.error.flatten());
  const userId = c.get('user').id;
  // keep only positions for tasks that exist in this project (prevents junk rows)
  const stmts = parsed.data.positions.map((p) =>
    c.env.DB.prepare(
      `INSERT INTO layout (user_id, task_id, x, y)
       SELECT ?1, t.id, ?2, ?3 FROM tasks t
       WHERE t.id = ?4 AND t.user_id = ?1 AND t.project_id = ?5
       ON CONFLICT (user_id, task_id) DO UPDATE SET x = excluded.x, y = excluded.y`
    ).bind(userId, p.x, p.y, p.task_id, c.req.param('projectId'))
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

miscRoutes.delete('/layout/:projectId', requireAuth, async (c) => {
  // "Reset layout" → auto layered layout recomputed client-side (FR-M8)
  await c.env.DB.prepare(
    `DELETE FROM layout WHERE user_id = ?1 AND task_id IN
       (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`
  ).bind(c.get('user').id, c.req.param('projectId')).run();
  return c.json({ ok: true });
});

// ---------- sync delta / polling fallback (FR-N3, FR-N5) ----------
miscRoutes.get('/sync', requireAuth, async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const since = Number(c.req.query('since') ?? 0);
  const rows = await c.env.DB.prepare(
    `SELECT id, type, payload, created_at FROM sync_log
     WHERE user_id = ?1 AND id > ?2 ORDER BY id LIMIT 500`
  ).bind(c.get('user').id, Number.isFinite(since) ? since : 0).all<any>();

  let running: unknown = null;
  let pomo: unknown = null;
  try {
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get('user').id));
    const res = await stub.fetch(new Request('https://do/state', { headers: { 'x-internal': '1' } }));
    if (res.ok) {
      const state = await res.json<any>();
      running = state.session; pomo = state.pomo;
    }
  } catch { /* charts stay correct via sync_log even if the DO is cold */ }

  return c.json({
    events: rows.results.map((r) => {
      let actor = 'unknown';
      let data: unknown = null;
      try {
        const p = JSON.parse(r.payload) as { actor: string; data: unknown };
        actor = p.actor;
        data = p.data;
      } catch { /* keep defaults */ }
      return { id: r.id, type: r.type, actor, at: r.created_at, data };
    }),
    running, pomo,
    server_now: Date.now()
  });
});

// ---------- version (NFR-9) ----------
miscRoutes.get('/version', (c) => c.json({
  name: 'timekeep-web',
  version: __BUILD_SHA__,
  now: Date.now()
}));
