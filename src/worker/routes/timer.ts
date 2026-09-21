// /api/timer/* and /api/pomo/* — thin authenticated proxies to the user's
// UserHub Durable Object, which is the single authority for the running timer
// and pomodoro state machine (§5.5.6, §5.7). GET /api/timer falls back to the
// active_timers mirror if the DO is unavailable (FR-S3 recovery path).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import type { Context } from 'hono';
import { jsonError } from '../env';
import { requireAuth } from '../middleware';
import { pomoStartSchema, ulidish } from '../validators';
import { z } from 'zod';

const timerOpSchema = z.object({
  task_id: ulidish,
  subtask_id: ulidish.nullable().optional()   // 0..1 subtask per session
});

export const timerRoutes = new Hono<WorkerType>();
timerRoutes.use('/timer', requireAuth);
timerRoutes.use('/timer/*', requireAuth);
timerRoutes.use('/pomo', requireAuth);
timerRoutes.use('/pomo/*', requireAuth);

async function callHub(c: Context<WorkerType>, path: string, body?: unknown, method = 'POST'): Promise<Response> {
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get('user').id));
  const url = `https://do${path}`;
  const req = body === undefined
    ? new Request(url, { method: 'GET', headers: { 'x-internal': '1' } })
    : new Request(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-internal': '1' },
      body: JSON.stringify(body)
    });
  return stub.fetch(req);
}

async function timerFallback(c: Context<WorkerType>) {
  // D1 mirror: authoritative enough to render the recovery banner if the DO is cold.
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.task_id, s.started_at, s.source, t.name AS task_name, p.name AS project_name
     FROM active_timers at
     JOIN time_sessions s ON s.id = at.session_id
     JOIN tasks t ON t.id = s.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE at.user_id = ?1`
  ).bind(c.get('user').id).first();
  return row ? { session: row, pomo: null } : { session: null, pomo: null };
}

timerRoutes.get('/timer', async (c) => {
  try {
    const res = await callHub(c, '/state');
    if (!res.ok) throw new Error(`hub ${res.status}`);
    return c.json(await res.json());
  } catch {
    return c.json(await timerFallback(c));
  }
});

timerRoutes.post('/timer/start', async (c) => {
  const parsed = timerOpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'task_id required');
  const res = await callHub(c, '/timer', { op: 'start', task_id: parsed.data.task_id, subtask_id: parsed.data.subtask_id ?? null, device: c.get('deviceId') });
  return forward(c, res);
});

timerRoutes.post('/timer/stop', async (c) => {
  const res = await callHub(c, '/timer', { op: 'stop', device: c.get('deviceId') });
  return forward(c, res);
});

// "switch to" — atomically stop old + start new, one API call, one event (FR-S1);
// subtask_id re-anchors the subtask too (same-task switches split the session)
timerRoutes.post('/timer/switch', async (c) => {
  const parsed = timerOpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'task_id required');
  const res = await callHub(c, '/timer', { op: 'switch', task_id: parsed.data.task_id, subtask_id: parsed.data.subtask_id ?? null, device: c.get('deviceId') });
  return forward(c, res);
});

// ---------- pomodoro (FR-F) ----------

timerRoutes.get('/pomo', async (c) => {
  try {
    const res = await callHub(c, '/state');
    if (!res.ok) throw new Error(`hub ${res.status}`);
    const state = await res.json<any>();
    return c.json({ pomo: state.pomo, server_now: state.server_now });
  } catch {
    return jsonError(503, 'hub_unavailable', 'timer hub unavailable — retry shortly');
  }
});

timerRoutes.post('/pomo/start', async (c) => {
  const parsed = pomoStartSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  const res = await callHub(c, '/pomo', { op: 'start', task_id: parsed.data.task_id, device: c.get('deviceId') });
  return forward(c, res);
});

timerRoutes.post('/pomo/start-break', async (c) => {
  const res = await callHub(c, '/pomo', { op: 'start_break', device: c.get('deviceId') });
  return forward(c, res);
});

timerRoutes.post('/pomo/skip', async (c) => {
  const res = await callHub(c, '/pomo', { op: 'skip', device: c.get('deviceId') });
  return forward(c, res);
});

function forward(c: Context<WorkerType>, res: Response): Response {
  // Preserve the DO's JSON envelope (errors included) — it owns the semantics.
  const status = res.status;
  return new Response(res.body, {
    status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' }
  });
}
