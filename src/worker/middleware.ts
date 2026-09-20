// Cross-cutting middleware: security headers (NFR-3), session auth with sliding
// expiry + rotation (FR-A6), CSRF (SameSite=Lax + Origin check + CSRF cookie),
// D1-backed atomic rate limiting, and optional Turnstile verification.

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { WorkerType, Env } from './env';
import { jsonError } from './env';
import { sha256Hex, timingSafeEqual, randomToken } from './auth';
import {
  SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, SESSION_TTL_MS, SESSION_ROTATE_BEFORE_MS
} from '../shared/constants';

const CSP_BODY = (turnstileOn: boolean) =>
  [
    "default-src 'self'",
    "script-src 'self'" + (turnstileOn ? ' https://challenges.cloudflare.com' : ''),
    // 'unsafe-inline' is a documented trade-off: React inline styles need it.
    // Tightening requires extracted styles or nonce-based CSS — revisit if the
    // stylesheet grows beyond inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'" + (turnstileOn ? ' https://challenges.cloudflare.com' : ''),
    "font-src 'self'",
    turnstileOn ? "frame-src https://challenges.cloudflare.com" : '',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'"
  ].filter(Boolean).join('; ');

/** Applies the full header set to any response — used for API *and* static-asset responses. */
export function securityHeadersFor(env: Env, res: Response, url: URL): Response {
  const out = new Response(res.body, res);
  const turnstileOn = !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY;
  out.headers.set('Content-Security-Policy', CSP_BODY(turnstileOn));
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Frame-Options', 'DENY');
  if (url.protocol === 'https:') out.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return out;
}

export const securityHeaders = createMiddleware<WorkerType>(async (c, next) => {
  await next();
  c.res = securityHeadersFor(c.env, c.res, new URL(c.req.url));
});

// ---------- session auth ----------

type Ctx = Context<WorkerType>;

interface SessionRow {
  id: string; user_id: string; token_hash: string;
  expires_at: number; last_seen_at: number;
}

async function loadSession(c: Ctx): Promise<{ session: SessionRow } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.last_seen_at
     FROM auth_sessions s WHERE s.token_hash = ?1`
  ).bind(hash).first<SessionRow>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1').bind(row.id).run();
    return null;
  }
  return { session: row };
}

async function rotateIfNeeded(c: Ctx, session: SessionRow): Promise<void> {
  const now = Date.now();
  const left = session.expires_at - now;
  // Sliding expiry: every authenticated request extends the window; rotate the
  // opaque token when it is within its final 7 days (FR-A6 "rotation on renewal").
  if (left < SESSION_ROTATE_BEFORE_MS) {
    const token = randomToken(32);
    const hash = await sha256Hex(token);
    const newId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`
      ).bind(newId, session.user_id, hash,
        c.req.header('user-agent') ?? '', clientIp(c) ?? '', now, now + SESSION_TTL_MS),
      c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1').bind(session.id)
    ]);
    setSessionCookie(c, token, now + SESSION_TTL_MS);
    c.set('authSessionId', newId);
  }
}

export function setSessionCookie(c: Ctx, token: string, expiresAtMs: number): void {
  const https = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: https, sameSite: 'Lax', path: '/',
    maxAge: Math.floor((expiresAtMs - Date.now()) / 1000)
  });
}

export function clearSessionCookie(c: Ctx): void {
  const https = new URL(c.req.url).protocol === 'https:';
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: https });
}

export function clientIp(c: Ctx): string | null {
  // cf-connecting-ip is absent under `wrangler dev`; x-forwarded-for keeps
  // per-client buckets distinct where a proxy provides one.
  const fwd = c.req.header('x-forwarded-for');
  return c.req.header('cf-connecting-ip') ?? (fwd ? fwd.split(',')[0]!.trim() : null) ?? null;
}

/**
 * Device ids are client-supplied and echoed into every broadcast event + the
 * sync_log payload — clamp them to a sane charset/length (audit S6).
 */
export function sanitizeDevice(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return d || 'unknown';
}

/**
 * Require a valid session; populates c.var.user. Throttles last_seen updates
 * (at most once a minute) to keep D1 writes off the hot path.
 */
export const requireAuth = createMiddleware<WorkerType>(async (c, next) => {
  const loaded = await loadSession(c);
  if (!loaded) return jsonError(401, 'unauthenticated', 'sign in required');
  const { session } = loaded;
  const now = Date.now();
  if (now - session.last_seen_at > 60_000) {
    // last-seen heartbeat only: expiry is a fixed 30-day window; renewal happens
    // via token rotation in the final 7 days (rotateIfNeeded), which issues a
    // fresh session with a full TTL.
    await c.env.DB.prepare('UPDATE auth_sessions SET last_seen_at = ?1 WHERE id = ?2')
      .bind(now, session.id).run();
  }
  const user = await c.env.DB.prepare(
    `SELECT id, username, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start,
            theme, role, active, must_change_password, email_verified_at, created_at
     FROM users WHERE id = ?1`
  ).bind(session.user_id).first<any>();
  if (!user) return jsonError(401, 'unauthenticated', 'sign in required');
  if (!user.active)
    return jsonError(403, 'account_disabled', 'this account has been deactivated — contact your administrator');
  // Forced password change (admin-managed accounts): until the password is
  // changed, block everything except the change itself, the profile read that
  // surfaces the flag, and logout.
  if (user.must_change_password && !passwordChangeAllowed(c.req.method, c.req.path))
    return jsonError(403, 'password_change_required', 'change your password before continuing');
  c.set('user', user);
  c.set('authSessionId', session.id);
  c.set('deviceId', sanitizeDevice(c.req.header('x-device-id')));
  await rotateIfNeeded(c, session);
  await next();
  // Re-issue the double-submit cookie if it was lost (browser restart while the
  // 30-day session cookie persists) so the second CSRF layer resumes.
  if (!getCookie(c, CSRF_COOKIE)) issueCsrfCookie(c);
});

/** While must_change_password is set, only these endpoints respond. */
function passwordChangeAllowed(method: string, path: string): boolean {
  return path === '/api/me/password'
    || path === '/api/auth/logout'
    || (path === '/api/me' && method === 'GET');
}

/** Admin-only surface: user management. Use after requireAuth (c.set('user') must exist). */
export const requireAdmin = createMiddleware<WorkerType>(async (c, next) => {
  if (c.get('user').role !== 'admin')
    return jsonError(403, 'forbidden', 'admin access required');
  await next();
});

// ---------- CSRF (NFR-3) ----------
// Defense in depth: SameSite=Lax cookies + Origin/Sec-Fetch-Site check on
// state-changing requests + double-submit CSRF cookie for cookie-carrying clients.

export const csrfGuard = createMiddleware<WorkerType>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const url = new URL(c.req.url);
  const origin = c.req.header('origin');
  const fetchSite = c.req.header('sec-fetch-site');

  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return jsonError(403, 'csrf', 'cross-site request blocked');
  }
  if (origin) {
    const allowed = allowedOrigins(c.env, url.origin);
    if (!allowed.includes(origin)) return jsonError(403, 'csrf', 'cross-origin request blocked');
  }
  // Double-submit check — browsers always send Origin on state-changing
  // requests, so the extra token check applies exactly to browser traffic.
  // Non-browser API clients (curl, integrations) without an Origin header
  // pass on cookie+SameSite alone.
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header(CSRF_HEADER);
  if (origin) {
    if (cookie && !header) return jsonError(403, 'csrf', 'missing csrf token');
    if (cookie && header && !timingSafeEqual(cookie, header)) {
      return jsonError(403, 'csrf', 'csrf mismatch');
    }
  }
  await next();
});

export function allowedOrigins(env: Env, requestOrigin: string): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [requestOrigin, ...extra];
}

export function issueCsrfCookie(c: Ctx): string {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing) return existing;
  const token = randomToken(16);
  const https = new URL(c.req.url).protocol === 'https:';
  setCookie(c, CSRF_COOKIE, token, { httpOnly: false, secure: https, sameSite: 'Lax', path: '/' });
  return token;
}

// ---------- rate limiting (KV sliding-window-ish counters, NFR-3) ----------

export interface RateRule { name: string; limit: number; windowMs: number }

/** Spec limits (NFR-3). Each limit is env-overridable (RL_*) for local dev/tests only. */
export const rateRules = (env: Partial<Env>): Record<string, RateRule> => {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    loginIp: { name: 'login_ip', limit: n(env.RL_LOGIN_IP, 10), windowMs: 15 * 60_000 },
    loginEmail: { name: 'login_email', limit: n(env.RL_LOGIN_EMAIL, 10), windowMs: 15 * 60_000 },
    resetEmail: { name: 'reset_email', limit: n(env.RL_RESET_EMAIL, 5), windowMs: 3600_000 },
    // unauthenticated token endpoints + admin mutations (CPU-heavy PBKDF2) — IP-keyed
    tokenIp: { name: 'token_ip', limit: n(env.RL_TOKEN_IP, 30), windowMs: 15 * 60_000 },
    adminIp: { name: 'admin_ip', limit: n(env.RL_ADMIN_IP, 20), windowMs: 15 * 60_000 },
    apiUser: { name: 'api_user', limit: n(env.RL_API_USER, 120), windowMs: 60_000 }
  };
};

/**
 * Returns null when allowed, or a Retry-After in seconds when the budget is spent.
 *
 * The counter is ONE atomic D1 upsert … RETURNING — D1 serializes statements per
 * row, so the increment cannot race (the previous KV get→put implementation let
 * concurrent requests read the same count and exceed every limit). Known
 * trade-off (documented): the per-identifier login rule means 10 failed attempts
 * lock a known username out for 15 min — distributed lockout-DoS is inherent to
 * per-account failure counters; production mitigates with Turnstile on the login
 * form.
 */
export async function rateLimitHit(env: Env, rule: RateRule, subject: string): Promise<number | null> {
  const now = Date.now();
  const win = Math.floor(now / rule.windowMs);
  const key = `${rule.name}:${subject}:${win}`;
  const expiresAt = now + rule.windowMs + 60_000;
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (key, n, window_start, expires_at)
     VALUES (?1, 1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET n = n + 1, expires_at = ?3
     RETURNING n`
  ).bind(key, win, expiresAt).first<{ n: number }>();
  const cur = Number(row?.n ?? 1);
  if (cur > rule.limit) return Math.ceil((rule.windowMs - (now % rule.windowMs)) / 1000);
  return null;
}

export function tooMany(retryAfterS: number) {
  return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'too many requests — retry later' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, retryAfterS)) }
  });
}

/**
 * Per-user throttle for heavy endpoints (reports, export, import, bootstrap,
 * sync — NFR-3 `apiUser`). Returns a 429 response when over budget, else null.
 * The counter lives in the user's UserHub DO (single instance per user → the
 * read-modify-write is atomic, and the hot per-user key does no KV writes).
 * Falls back to KV when the DO is unavailable.
 * Deliberately NOT applied to every request: chatty small requests would
 * round-trip the DO needlessly.
 */
export async function limitHeavy(c: Ctx): Promise<Response | null> {
  const rule = rateRules(c.env).apiUser;
  const userId = c.get('user').id;
  try {
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
    const res = await stub.fetch(new Request('https://do/ratelimit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal': '1' },
      body: JSON.stringify({ key: rule.name, limit: rule.limit, windowMs: rule.windowMs })
    }));
    if (res.ok) {
      const out = await res.json() as { limited: boolean; retry_after_s: number };
      return out.limited ? tooMany(out.retry_after_s) : null;
    }
  } catch { /* DO unavailable → KV fallback below */ }
  const rl = await rateLimitHit(c.env, rule, userId);
  return rl ? tooMany(rl) : null;
}

// ---------- Turnstile (FR-A2) ----------

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured → disabled (dev)
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json<{ success: boolean }>();
  return data.success === true;
}
