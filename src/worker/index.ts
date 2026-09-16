// TimeKeep Web — Worker entry (M0).
// One Worker serves /api/* (Hono) and the SPA (Static Assets, SPA fallback).
// Exported: the Hono fetch handler, the UserHub DO, and the scheduled cron.
import { Hono } from 'hono';
import type { WorkerType } from './env';
import { securityHeaders, csrfGuard, requireAuth, optionalAuth } from './middleware';
import { sha256Hex } from './auth';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { adminRoutes } from './routes/admin';
import { projectRoutes } from './routes/projects';
import { taskRoutes } from './routes/tasks';
import { sessionRoutes } from './routes/sessions';
import { timerRoutes } from './routes/timer';
import { reportRoutes } from './routes/reports';
import { miscRoutes } from './routes/misc';
import { exportRoutes } from './routes/export';
import { runDailyCron } from './cron';
import { UserHub } from './do/user-hub';

export { UserHub };

const app = new Hono<WorkerType>();

app.use('*', securityHeaders);

// health + version (unauthenticated, NFR-9)
app.get('/api/version', (c) => c.json({
  name: 'timekeep-web',
  version: __BUILD_SHA__,
  now: Date.now()
}));

// WebSocket upgrade → user's UserHub. The Worker re-verifies the session cookie
// (§5.6: "WebSocket upgrades re-verify the session"); the DO itself is only
// reachable from this Worker (internal fetch), never from the public internet.
app.get('/api/ws', async (c) => {
  if (c.req.header('upgrade') !== 'websocket')
    return c.json({ error: { code: 'bad_request', message: 'websocket upgrade required' } }, 400);
  const cookieHeader = c.req.header('cookie') ?? '';
  const match = cookieHeader.match(/(?:^|;\s*)tk_session=([A-Za-z0-9]+)/);
  if (!match) return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
  const hash = await sha256Hex(match[1]!);
  const row = await c.env.DB.prepare(
    'SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?1'
  ).bind(hash).first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now())
    return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);

  const device = new URL(c.req.url).searchParams.get('device') ?? 'unknown';
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(row.user_id));
  return stub.fetch(new Request(`https://do/ws?device=${encodeURIComponent(device)}`, {
    headers: c.req.raw.headers
  }));
});

// all API routes: CSRF guard on state-changing methods (NFR-3)
app.use('/api/*', csrfGuard);

app.route('/api', authRoutes);      // login/logout/reset (own rate limits + Turnstile)
app.route('/api', meRoutes);        // requireAuth inside
app.route('/api', adminRoutes);     // user management, requireAdmin inside
app.route('/api', projectRoutes);   // requireAuth inside
app.route('/api', taskRoutes);
app.route('/api', sessionRoutes);
app.route('/api', timerRoutes);
app.route('/api', reportRoutes);
app.route('/api', exportRoutes);
app.route('/api', miscRoutes);      // /bootstrap, /settings, /layout, /sync, /version

// error envelope {error:{code,message,details?}} (§5.3 conventions)
app.onError((err, c) => {
  const anyErr = err as any;
  if (anyErr?.status && anyErr?.code) {
    return c.json({
      error: {
        code: anyErr.code,
        message: anyErr.message,
        ...(anyErr.details !== undefined ? { details: anyErr.details } : {})
      }
    }, anyErr.status);
  }
  console.error(JSON.stringify({ evt: 'unhandled_error', path: c.req.path, message: String(err?.message ?? err) }));
  return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'unknown API route' } }, 404));

export default {
  async fetch(request: Request, env: WorkerType['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    // SPA via Static Assets (not_found_handling: single-page-application)
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: WorkerType['Bindings'], _ctx: ExecutionContext): Promise<void> {
    await runDailyCron(env);
  }
};
