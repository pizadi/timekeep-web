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
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_TTL_MS,
  SESSION_ROTATE_BEFORE_MS,
} from '../shared/constants';

const CSP_BODY = (turnstileOn: boolean) =>
  [
    "default-src 'self'",
    "script-src 'self'" + (turnstileOn ? ' https://challenges.cloudflare.com' : ''),
    // 'unsafe-inline' is a documented trade-off: React inline styles need it
    // (~200 `style={{…}}` sites), and a CSS custom property set through the
    // style attribute is still an inline style, so it buys nothing.
    // `style-src-elem 'self'` is the cheap containment: an injected <style>
    // block is refused while inline style attributes keep working. Browsers
    // without CSP3's style-src-elem (pre-2022 Safari) ignore it and fall back
    // to style-src, i.e. today's behavior — it can only tighten, never break.
    // Dropping 'unsafe-inline' entirely means extracting every inline style
    // (audit #5); test/csp.test.ts locks the "no HTML sinks" half of it.
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self'",
    "img-src 'self' data:",
    "connect-src 'self'" + (turnstileOn ? ' https://challenges.cloudflare.com' : ''),
    "font-src 'self'",
    turnstileOn ? 'frame-src https://challenges.cloudflare.com' : '',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ]
    .filter(Boolean)
    .join('; ');

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

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  last_seen_at: number;
}

async function loadSession(c: Ctx): Promise<{ session: SessionRow } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.last_seen_at
     FROM auth_sessions s WHERE s.token_hash = ?1`,
  )
    .bind(hash)
    .first<SessionRow>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1').bind(row.id).run();
    return null;
  }
  return { session: row };
}

export type RotateOutcome =
  /** outside the rotation window, or another request rotated first — no cookie change */
  | 'skipped'
  /** the token was rotated in place; `token` is the new cookie value */
  | { rotated: true; token: string; expiresAt: number }
  /** the session row disappeared mid-request (logout / revoke / reset) — INV-01 */
  | 'revoked';

/**
 * Sliding expiry: every authenticated request extends the window; the opaque
 * token is rotated when it is within its final 7 days (FR-A6 "rotation on
 * renewal").
 *
 * The rotation is a single compare-and-swap on the hash that was read:
 *
 *   UPDATE auth_sessions SET token_hash = … WHERE id = ? AND token_hash = <read hash>
 *
 * not INSERT + DELETE. Every revocation path (logout, revoke-others, password
 * change, reset, admin deactivate) DELETEs by `id` or by `user_id`, so once a
 * revoke has removed the row the CAS affects 0 rows and the rotation fails —
 * a revoked session can never produce a valid replacement, no matter how the
 * two requests interleave (INV-01). The same CAS also disambiguates a peer
 * request that rotated first: the row is still alive, so we return 'skipped'
 * and set no cookie rather than clobbering the token the other response
 * installed.
 */
export async function rotateSession(
  db: D1Database,
  session: SessionRow,
  now: number,
  userAgent: string,
  ip: string,
): Promise<RotateOutcome> {
  if (session.expires_at - now >= SESSION_ROTATE_BEFORE_MS) return 'skipped';
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  const res = await db
    .prepare(
      `UPDATE auth_sessions
       SET token_hash = ?1, user_agent = ?2, ip = ?3, last_seen_at = ?4, expires_at = ?5
       WHERE id = ?6 AND token_hash = ?7`,
    )
    .bind(hash, userAgent, ip, now, expiresAt, session.id, session.token_hash)
    .run();
  if (Number(res.meta?.changes ?? 0) === 1) return { rotated: true, token, expiresAt };
  // CAS lost — revoked, or a concurrent rotation of the same session.
  const alive = await db.prepare('SELECT 1 AS ok FROM auth_sessions WHERE id = ?1').bind(session.id).first();
  return alive ? 'skipped' : 'revoked';
}

async function rotateIfNeeded(c: Ctx, session: SessionRow): Promise<boolean> {
  const outcome = await rotateSession(
    c.env.DB,
    session,
    Date.now(),
    c.req.header('user-agent') ?? '',
    clientIp(c) ?? '',
  );
  if (outcome === 'revoked') return false;
  if (outcome !== 'skipped') setSessionCookie(c, outcome.token, outcome.expiresAt);
  return true;
}

export function setSessionCookie(c: Ctx, token: string, expiresAtMs: number): void {
  const https = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: https,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor((expiresAtMs - Date.now()) / 1000),
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
  // Route files register BOTH a bare path and its wildcard
  // (`use('/me', …)` + `use('/me/*', …)`), and Hono matches a bare path
  // against both — so without this guard requireAuth runs TWICE for every bare
  // path. The second run re-reads the session from the *request* cookie, which
  // a rotation has already invalidated, and 401s a request the first run had
  // already authorized (signing the user out in the last 7 days of a session).
  // It also doubled the D1 reads on the hot path.
  if (c.get('user')) return next();
  const loaded = await loadSession(c);
  if (!loaded) return jsonError(401, 'unauthenticated', 'sign in required');
  const { session } = loaded;
  const now = Date.now();
  if (now - session.last_seen_at > 60_000) {
    // last-seen heartbeat only: expiry is a fixed 30-day window; renewal happens
    // via token rotation in the final 7 days (rotateIfNeeded), which issues a
    // fresh session with a full TTL.
    await c.env.DB.prepare('UPDATE auth_sessions SET last_seen_at = ?1 WHERE id = ?2').bind(now, session.id).run();
  }
  const user = await c.env.DB.prepare(
    `SELECT id, username, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start,
            theme, role, active, must_change_password, email_verified_at, created_at
     FROM users WHERE id = ?1`,
  )
    .bind(session.user_id)
    .first<any>();
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
  // Rotation is a CAS on this row: if the session was revoked while the request
  // was in flight, the rotation fails and the request is rejected here rather
  // than minting a replacement token for a dead session (INV-01).
  if (!(await rotateIfNeeded(c, session))) return jsonError(401, 'unauthenticated', 'sign in required');
  await next();
  // Re-issue the double-submit cookie if it was lost (browser restart while the
  // 30-day session cookie persists) so the second CSRF layer resumes.
  if (!getCookie(c, CSRF_COOKIE)) issueCsrfCookie(c);
});

/** While must_change_password is set, only these endpoints respond. */
function passwordChangeAllowed(method: string, path: string): boolean {
  return path === '/api/me/password' || path === '/api/auth/logout' || (path === '/api/me' && method === 'GET');
}

/** Admin-only surface: user management. Use after requireAuth (c.set('user') must exist). */
export const requireAdmin = createMiddleware<WorkerType>(async (c, next) => {
  if (c.get('user').role !== 'admin') return jsonError(403, 'forbidden', 'admin access required');
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
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
}

/** Spec limits (NFR-3). Each limit is env-overridable (RL_*) for local dev/tests only. */
export const rateRules = (env: Partial<Env>): Record<string, RateRule> => {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    loginIp: { name: 'login_ip', limit: n(env.RL_LOGIN_IP, 10), windowMs: 15 * 60_000 },
    // F6 (audit): the old per-identifier counter (login_email, 10/15min on the
    // bare identifier) let anyone who KNEW a username keep that username locked
    // out — usernames aren't secret, and a looping attacker didn't even need
    // many IPs. Two counters now:
    //  - login_user_ip: one source's failures against one identifier. A single
    //    attacker exhausts only their own pair; the victim's usual network is
    //    never charged for it.
    //  - login_identity: an identifier-wide ceiling, 4× looser, bounding a
    //    DISTRIBUTED attack's volume on one account. Some victim-lockout window
    //    is inherent to any per-account failure counter; this shrinks the
    //    blast radius while keeping brute force bounded.
    loginUserIp: { name: 'login_user_ip', limit: n(env.RL_LOGIN_USER_IP, 10), windowMs: 15 * 60_000 },
    loginIdentity: { name: 'login_identity', limit: n(env.RL_LOGIN_IDENTITY, 40), windowMs: 15 * 60_000 },
    resetEmail: { name: 'reset_email', limit: n(env.RL_RESET_EMAIL, 5), windowMs: 3600_000 },
    // Password-reset fan-out: the per-address rule above stops one mailbox being
    // spammed, but nothing stopped ONE source asking for many distinct
    // addresses (mail-provider quota, notification spam, service cost — the
    // audit's #11). IP-keyed and deliberately loose, since a shared office or
    // a NAT legitimately has several people resetting passwords.
    resetIp: { name: 'reset_ip', limit: n(env.RL_RESET_IP, 20), windowMs: 3600_000 },
    // unauthenticated token endpoints + admin mutations (CPU-heavy PBKDF2) — IP-keyed
    tokenIp: { name: 'token_ip', limit: n(env.RL_TOKEN_IP, 30), windowMs: 15 * 60_000 },
    adminIp: { name: 'admin_ip', limit: n(env.RL_ADMIN_IP, 20), windowMs: 15 * 60_000 },
    apiUser: { name: 'api_user', limit: n(env.RL_API_USER, 120), windowMs: 60_000 },
    // state-changing CRUD/timer/group writes (the audit's 🟠1): those routes had
    // only eventual entity-count caps, so a leaked session could hammer
    // /timer/start-stop in a loop — each call a D1 write + DO round-trip + WS
    // fan-out. Generous enough that no human hits it (polling/reports are all
    // GETs and ride apiUser), low enough to cap abuse at a few writes/second.
    writeUser: { name: 'write_user', limit: n(env.RL_WRITE_USER, 300), windowMs: 60_000 },
    // The budget that actually bounds DATABASE work. A per-minute request cap
    // is not a cost cap: 300/min is ~432k requests/day for one account, and
    // social mutations write one sync_log row per group member on top of the
    // entity row. This is the ceiling on sustained D1 writes per account per
    // day, and it is the number the audit's "bound the work, not the request
    // count" asks for (INV-12). Env-overridable for tests, like the others.
    writeUserDay: { name: 'write_user_day', limit: n(env.RL_WRITE_USER_DAY, 20_000), windowMs: 24 * 3600_000 },
    // Fan-out routes (group projects/membership/chat): one request here writes
    // up to LIMITS.membersPerGroup rows, so it gets its own, much lower,
    // per-minute allowance instead of the ordinary write budget.
    socialWrite: { name: 'social_write', limit: n(env.RL_SOCIAL_WRITE, 60), windowMs: 60_000 },
    // friend requests + username lookups (blocks request spam and cheap
    // username enumeration — the only user-existence oracle in the app)
    socialUser: { name: 'social_user', limit: n(env.RL_SOCIAL_USER, 30), windowMs: 3600_000 },
  };
};

/**
 * Returns null when allowed, or a Retry-After in seconds when the budget is spent.
 *
 * The counter is ONE atomic D1 upsert … RETURNING — D1 serializes statements per
 * row, so the increment cannot race (the previous KV get→put implementation let
 * concurrent requests read the same count and exceed every limit). Known
 * trade-off (documented, audit F6): per-account failure counters can lock a
 * victim out — mitigated by keying the tight counter on (identifier, ip) with
 * only a loose identifier-wide ceiling, and by Turnstile on the login form in
 * production.
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
     RETURNING n`,
  )
    .bind(key, win, expiresAt)
    .first<{ n: number }>();
  const cur = Number(row?.n ?? 1);
  if (cur > rule.limit) return Math.ceil((rule.windowMs - (now % rule.windowMs)) / 1000);
  return null;
}

export function tooMany(retryAfterS: number) {
  return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'too many requests — retry later' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, retryAfterS)) },
  });
}

/**
 * Per-user counter shared by the throttles below. The counter lives in the
 * user's UserHub DO (single instance per user → the read-modify-write is
 * atomic, and the hot per-user key does no shared-key writes); falls back to
 * the atomic D1 upsert when the DO is unavailable.
 *
 * Takes a LIST of rules and charges them in ONE round trip: a write spends both
 * its per-minute budget and its daily budget, and two DO calls per mutation
 * would be a silly price for that.
 */
async function userRateLimit(c: Ctx, rules: RateRule[]): Promise<Response | null> {
  const userId = c.get('user').id;
  try {
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
    const res = await stub.fetch(
      new Request('https://do/ratelimit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal': '1' },
        body: JSON.stringify({
          rules: rules.map((r) => ({ key: r.name, limit: r.limit, windowMs: r.windowMs })),
        }),
      }),
    );
    if (res.ok) {
      const out = (await res.json()) as { limited: boolean; retry_after_s: number };
      return out.limited ? tooMany(out.retry_after_s) : null;
    }
  } catch {
    /* DO unavailable → D1 fallback below */
  }
  for (const rule of rules) {
    const rl = await rateLimitHit(c.env, rule, userId);
    if (rl) return tooMany(rl);
  }
  return null;
}

/**
 * Per-user throttle for heavy READ endpoints (reports, export, import,
 * bootstrap, sync — NFR-3 `apiUser`). Returns a 429 response when over budget,
 * else null. Deliberately NOT applied to every request: chatty small requests
 * would round-trip the DO needlessly.
 */
export async function limitHeavy(c: Ctx): Promise<Response | null> {
  return userRateLimit(c, [rateRules(c.env).apiUser]);
}

/** The shared body of both write throttles; see limitWrites for the rules. */
function writeThrottle(rulesOf: (r: ReturnType<typeof rateRules>) => RateRule[]) {
  return createMiddleware<WorkerType>(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    if (c.get('writeLimited')) return next();
    c.set('writeLimited', true);
    if (!c.get('user')) return next(); // always chained after requireAuth; defensive only
    const limited = await userRateLimit(c, rulesOf(rateRules(c.env)));
    if (limited) return limited;
    return next();
  });
}

/**
 * Per-user throttle for state-changing writes (audit 🟠1, `writeUser`).
 * Route-level middleware, chained after `requireAuth` in every route file that
 * mutates state — the CRUD/task/session/timer/group routes used to have no rate
 * limit at all, only eventual entity-count caps.
 *
 * TWO budgets, not one. A per-minute request cap says nothing about the cost a
 * request actually imposes on D1: at 300/min a single account can drive ~432k
 * requests a day, and one social mutation writes a `sync_log` row per group
 * member, so the real D1 write rate is up to two orders of magnitude above what
 * the request limiter implies. The daily budget is the one that bounds actual
 * database work over time; the per-minute one is what keeps a burst smooth.
 *
 * Reads are skipped: the SPA's polling and report refetches are all GETs and
 * ride `apiUser` instead. The once-per-request flag matters because two route
 * files can register a `use` chain for the same path (tasks.ts and projects.ts
 * both cover `/projects/*`) — without it one write would be counted twice.
 */
export const limitWrites = writeThrottle((r) => [r.writeUser, r.writeUserDay]);

/**
 * The same daily budget, for the routes where ONE request costs N database
 * writes: group projects, group membership and chat all fan a `sync_log` event
 * out to every member (up to LIMITS.membersPerGroup), so they get a much lower
 * per-minute allowance than ordinary CRUD. Use this INSTEAD of limitWrites on
 * those routes — chaining both would spend the daily budget twice per request.
 */
export const limitSocialWrites = writeThrottle((r) => [r.socialWrite, r.writeUserDay]);

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
