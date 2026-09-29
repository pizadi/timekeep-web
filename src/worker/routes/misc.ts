// Bootstrap (one-shot initial state), settings (FR-C), layout persistence (FR-M8),
// sync delta (FR-N3/N5), version (NFR-9).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy, limitWrites } from '../middleware';
import { settingsSchema, layoutSchema } from '../validators';
import { commitWithEvents, type EventDraft } from '../events';
import type { WsEvent } from '../../shared/constants';
import { socialLists } from './friends';
import { groupLists } from './groups';
import { DEFAULT_SETTINGS } from '../defaults';
import { LIMITS } from '../../shared/constants';

export const miscRoutes = new Hono<WorkerType>();

// ---------- public config (pre-auth: Turnstile widget needs the site key) ----------
miscRoutes.get('/config', (c) => c.json({ turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null }));

// ---------- bootstrap ----------
miscRoutes.get('/bootstrap', requireAuth, async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const [projects, tasks, subtasks, deps, settingsRow, recent, hubState, social, groups, goals] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, user_id, name, color, archived, position, visibility, group_id, created_at, updated_at
       FROM projects
       WHERE deleted_at IS NULL
         AND (user_id = ?1 OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1))
       ORDER BY position, created_at`,
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM tasks
       WHERE deleted_at IS NULL
         AND (user_id = ?1
          OR project_id IN (SELECT id FROM projects WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1)))
       ORDER BY position, created_at`,
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM subtasks
       WHERE user_id = ?1
          OR task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
                         WHERE t.deleted_at IS NULL
                           AND p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1))
       ORDER BY position, created_at`,
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM task_dependencies
       WHERE user_id = ?1
          OR task_id IN (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
                         WHERE p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1))`,
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1').bind(userId).first<{ data: string }>(),
    // "Jump back in" / Resume: tasks by recency of tracked work, not position —
    // and each entry carries the subtask of that task's NEWEST session, so
    // Resume restores the subtask you last tracked. A GROUP BY would drop the
    // subtask column, hence the window function.
    c.env.DB.prepare(
      // a tombstoned task is not a place to resume (INV-06) — its time stays in
      // the log and the reports, it just is not a "jump back in" destination
      `SELECT task_id, subtask_id FROM (
         SELECT s.task_id AS task_id, s.subtask_id AS subtask_id, s.started_at AS started_at,
                ROW_NUMBER() OVER (PARTITION BY s.task_id ORDER BY s.started_at DESC) AS rn
         FROM time_sessions s JOIN tasks t ON t.id = s.task_id
         WHERE s.user_id = ?1 AND t.deleted_at IS NULL
       ) WHERE rn = 1
       ORDER BY started_at DESC
       LIMIT 6`,
    )
      .bind(userId)
      .all<{ task_id: string; subtask_id: string | null }>(),
    (async () => {
      try {
        const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
        const res = await stub.fetch(new Request('https://do/state', { headers: { 'x-internal': '1' } }));
        return res.ok ? await res.json() : { session: null, pomo: null };
      } catch {
        return { session: null, pomo: null };
      }
    })(),
    socialLists(c.env.DB, userId),
    groupLists(c.env.DB, userId),
    c.env.DB.prepare(
      `SELECT id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at
       FROM goals WHERE user_id = ?1 ORDER BY created_at`,
    )
      .bind(userId)
      .all(),
  ]);

  return c.json({
    user: c.get('user'),
    settings: mergeSettings(settingsRow?.data),
    projects: projects.results,
    tasks: tasks.results,
    subtasks: subtasks.results,
    dependencies: deps.results,
    // scope arrives as a JSON string from D1 — parse it to match the API's Goal shape
    goals: goals.results.map((g: any) => ({ ...g, scope: JSON.parse(g.scope) })),
    recent: recent.results.map((r) => ({ task_id: r.task_id, subtask_id: r.subtask_id ?? null })),
    friends: social.friends,
    incoming_requests: social.incoming,
    outgoing_requests: social.outgoing,
    groups: groups.groups,
    group_invites: groups.incoming_invites,
    running: (hubState as any).session ?? null,
    pomo: (hubState as any).pomo ?? null,
    last_event_id: (hubState as any).last_event_id ?? 0,
    devices: (hubState as any).devices ?? 0,
    server_now: Date.now(),
  });
});

export function mergeSettings(raw?: string) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------- settings (FR-C1: server-validated, syncs everywhere) ----------
miscRoutes.get('/settings', requireAuth, async (c) => {
  const row = await c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
    .bind(c.get('user').id)
    .first<{ data: string }>();
  return c.json({ settings: mergeSettings(row?.data), turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null });
});

miscRoutes.put('/settings', requireAuth, limitWrites, async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid settings payload', parsed.error.flatten());

  const row = await c.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
    .bind(c.get('user').id)
    .first<{ data: string }>();
  const current = mergeSettings(row?.data);
  const next = {
    ...current,
    ...(parsed.data.pomodoro ? { pomodoro: { ...current.pomodoro, ...parsed.data.pomodoro } } : {}),
    ...(parsed.data.grace_min !== undefined ? { grace_min: parsed.data.grace_min } : {}),
    ...(parsed.data.notifications_enabled !== undefined
      ? { notifications_enabled: parsed.data.notifications_enabled }
      : {}),
    ...(parsed.data.sound_enabled !== undefined ? { sound_enabled: parsed.data.sound_enabled } : {}),
    ...(parsed.data.theme !== undefined ? { theme: parsed.data.theme } : {}),
  };
  // settings write + profile theme mirror + event in ONE batch (audit: three
  // unrelated round-trips could leave theme/settings/event divergent on a
  // crash). commitWithEvents is that batch, with the same statements.
  const evs = await commitWithEvents(
    c.env,
    c.get('user').id,
    [{ type: 'settings.updated', actor: c.get('deviceId'), data: { settings: next } }],
    [
      c.env.DB.prepare(
        `INSERT INTO settings (user_id, data) VALUES (?1, ?2)
           ON CONFLICT (user_id) DO UPDATE SET data = excluded.data`,
      ).bind(c.get('user').id, JSON.stringify(next)),
      ...(parsed.data.theme !== undefined
        ? [
            c.env.DB.prepare('UPDATE users SET theme = ?1, updated_at = ?2 WHERE id = ?3').bind(
              parsed.data.theme,
              Date.now(),
              c.get('user').id,
            ),
          ]
        : []),
    ],
    c.executionCtx,
  );
  return c.json({ settings: next, events: evs });
});

// ---------- map layout (FR-M8) ----------
miscRoutes.get('/layout/:projectId', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.task_id, l.x, l.y FROM layout l
     JOIN tasks t ON t.id = l.task_id
     WHERE l.user_id = ?1 AND t.project_id = ?2`,
  )
    .bind(c.get('user').id, c.req.param('projectId'))
    .all();
  return c.json({ positions: rows.results });
});

const CHUNK = 50; // stay under D1 batch statement limits (same as import)

miscRoutes.put('/layout/:projectId', requireAuth, limitWrites, async (c) => {
  const parsed = layoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid layout payload', parsed.error.flatten());
  const userId = c.get('user').id;
  // keep only positions for tasks that exist in this project (prevents junk rows)
  const stmts = parsed.data.positions.map((p) =>
    c.env.DB.prepare(
      `INSERT INTO layout (user_id, task_id, x, y)
       SELECT ?1, t.id, ?2, ?3 FROM tasks t
       WHERE t.id = ?4 AND t.user_id = ?1 AND t.project_id = ?5
       ON CONFLICT (user_id, task_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
    ).bind(userId, p.x, p.y, p.task_id, c.req.param('projectId')),
  );
  // audit: layout used to fan out nothing — other devices kept stale map
  // positions until a full reload. Clients react by refetching the layout.
  //
  // The positions and the event share ONE batch (INV-11). The layout schema
  // caps a project at LIMITS.tasksPerUser positions, which exceeds a single
  // D1 batch's statement limit, so this is the one route that keeps the
  // CHUNK loop — and the event is appended to the LAST chunk rather than
  // written after all of them, which is what keeps "positions saved" and
  // "other devices told" a single commit for any realistic payload.
  const draft: EventDraft = {
    type: 'layout.updated',
    actor: c.get('deviceId'),
    data: { project_id: c.req.param('projectId'), count: parsed.data.positions.length },
  };
  if (stmts.length <= CHUNK) {
    const { events } = await commitWithEvents(c.env, userId, [draft], stmts, c.executionCtx);
    return c.json({ ok: true, events });
  }
  let evs: WsEvent[] = [];
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const chunk = stmts.slice(i, i + CHUNK);
    const last = i + CHUNK >= stmts.length;
    const out = await commitWithEvents(c.env, userId, last ? [draft] : [], chunk, last ? c.executionCtx : undefined);
    evs = out.events;
  }
  return c.json({ ok: true, events: evs });
});

miscRoutes.delete('/layout/:projectId', requireAuth, limitWrites, async (c) => {
  // "Reset layout" → auto layered layout recomputed client-side (FR-M8)
  const evs = await commitWithEvents(
    c.env,
    c.get('user').id,
    [{ type: 'layout.updated', actor: c.get('deviceId'), data: { project_id: c.req.param('projectId'), count: 0 } }],
    [
      c.env.DB.prepare(
        `DELETE FROM layout WHERE user_id = ?1 AND task_id IN
             (SELECT id FROM tasks WHERE project_id = ?2 AND user_id = ?1)`,
      ).bind(c.get('user').id, c.req.param('projectId')),
    ],
    c.executionCtx,
  );
  return c.json({ ok: true, events: evs });
});

// ---------- sync delta / polling fallback (FR-N3, FR-N5) ----------
miscRoutes.get('/sync', requireAuth, async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const since = Number(c.req.query('since') ?? 0);
  const rows = await c.env.DB.prepare(
    `SELECT id, type, payload, created_at FROM sync_log
     WHERE user_id = ?1 AND id > ?2 ORDER BY id LIMIT ${LIMITS.syncPageMax}`,
  )
    .bind(c.get('user').id, Number.isFinite(since) ? since : 0)
    .all<any>();

  let running: unknown = null;
  let pomo: unknown = null;
  try {
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get('user').id));
    const res = await stub.fetch(new Request('https://do/state', { headers: { 'x-internal': '1' } }));
    if (res.ok) {
      const state = await res.json<any>();
      running = state.session;
      pomo = state.pomo;
    }
  } catch {
    /* charts stay correct via sync_log even if the DO is cold */
  }

  return c.json({
    events: rows.results.map((r) => {
      let actor = 'unknown';
      let data: unknown = null;
      try {
        const p = JSON.parse(r.payload) as { actor: string; data: unknown };
        actor = p.actor;
        data = p.data;
      } catch {
        /* keep defaults */
      }
      return { id: r.id, type: r.type, actor, at: r.created_at, data };
    }),
    running,
    pomo,
    server_now: Date.now(),
  });
});

// ---------- version (NFR-9) ----------
// GET /api/version is registered in index.ts (unauthenticated).
