// TimeKeep Web — Worker entry (M0).
// One Worker serves /api/* (Hono) and the SPA (Static Assets, SPA fallback).
// Exported: the Hono fetch handler, the UserHub DO, and the scheduled cron.
import { Hono } from 'hono';
import type { WorkerType } from './env';
import { securityHeaders, securityHeadersFor, csrfGuard, requireAuth, sanitizeDevice } from './middleware';
import { sha256Hex } from './auth';
import { SESSION_COOKIE } from '../shared/constants';
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
import { friendRoutes } from './routes/friends';
import { groupRoutes } from './routes/groups';
import { chatRoutes } from './routes/chat';
import { runDailyCron } from './cron';
import { UserHub } from './do/user-hub';

export { UserHub };

const app = new Hono<WorkerType>();

app.use('*', securityHeaders);

// health + version (unauthenticated, NFR-9). `version` is the app semver from
// package.json (injected at build/deploy); `build` is the deploy SHA. The
// typeof guard keeps ad-hoc `wrangler deploy` calls (without the --define)
// honest instead of crashing on a missing global.
const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
app.get('/api/version', (c) => c.json({
  name: 'timekeep-web',
  version: APP_VERSION,
  build: __BUILD_SHA__,
  now: Date.now()
}));

// WebSocket upgrade → user's UserHub. The Worker re-verifies the session cookie
// AND applies the same gates as requireAuth (§5.6: "WebSocket upgrades re-verify
// the session") — the DO itself is only reachable from this Worker (internal
// fetch, x-internal marker checked DO-side), never from the public internet.
app.get('/api/ws', async (c) => {
  // HTTP tokens are case-insensitive — compare lowercased
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket')
    return c.json({ error: { code: 'bad_request', message: 'websocket upgrade required' } }, 400);
  // defense in depth (SameSite=Lax already blocks cross-site cookies): reject
  // cross-origin upgrade attempts when the browser supplies an Origin
  const origin = c.req.header('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(c.req.url).host)
        return c.json({ error: { code: 'csrf', message: 'cross-origin request blocked' } }, 403);
    } catch {
      return c.json({ error: { code: 'csrf', message: 'cross-origin request blocked' } }, 403);
    }
  }
  const cookieHeader = c.req.header('cookie') ?? '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9]+)`));
  if (!match) return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
  const hash = await sha256Hex(match[1]!);
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, expires_at FROM auth_sessions WHERE token_hash = ?1'
  ).bind(hash).first<{ id: string; user_id: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now())
    return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
  // same gates as requireAuth: a deactivated or forced-password-change account
  // must not be able to stream events over a socket (audit S2)
  const user = await c.env.DB.prepare('SELECT active, must_change_password FROM users WHERE id = ?1')
    .bind(row.user_id).first<{ active: 0 | 1; must_change_password: 0 | 1 }>();
  if (!user || !user.active)
    return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
  if (user.must_change_password)
    return c.json({ error: { code: 'password_change_required', message: 'change your password before continuing' } }, 403);

  const device = sanitizeDevice(new URL(c.req.url).searchParams.get('device'));
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(row.user_id));
  // sid tags the socket DO-side so /revoke can selectively close just this
  // session's sockets (audit S1); x-internal marks the request as Worker-internal
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-internal', '1');
  return stub.fetch(new Request(`https://do/ws?device=${encodeURIComponent(device)}&sid=${encodeURIComponent(row.id)}`, {
    headers
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
app.route('/api', friendRoutes);     // friends, friend-visible projects, presence
app.route('/api', groupRoutes);      // groups, membership, invites/links
app.route('/api', chatRoutes);       // group chat (member-gated, fan-out delivery)
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
    // SPA via Static Assets (not_found_handling: single-page-application) — with the
    // same security headers as the API (CSP/HSTS/XFO/nosniff must cover the HTML shell)
    const res = await env.ASSETS.fetch(request);
    return securityHeadersFor(env, res, url);
  },

  async scheduled(_event: ScheduledController, env: WorkerType['Bindings'], _ctx: ExecutionContext): Promise<void> {
    await runDailyCron(env);
  }
};
