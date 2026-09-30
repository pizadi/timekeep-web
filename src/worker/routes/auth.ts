// FR-A: login, logout, password reset (no enumeration), all rate-limited per
// NFR-3. Self-signup is intentionally absent — accounts are created by the
// admin (routes/admin.ts); the initial admin is seeded by migration 0002.
import { Hono } from 'hono';
import type { WorkerType, Env } from '../env';
import { jsonError } from '../env';
import { publicOriginStrict } from '../../shared/public-url';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  getEmailSender,
  isCommonPassword,
  realEmail,
} from '../auth';
import {
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  clientIp,
  rateLimitHit,
  tooMany,
  rateRules,
  verifyTurnstile,
  issueCsrfCookie,
} from '../middleware';
import { revokeHub } from '../events';

import { loginSchema, verifyEmailSchema, resetRequestSchema, resetConfirmSchema } from '../validators';
import { passwordProblem } from '../../shared/validation';
import { SESSION_TTL_MS } from '../../shared/constants';

export const authRoutes = new Hono<WorkerType>();

// Reset/verification links carry a bearer token, so their origin comes from
// deployment configuration (APP_PUBLIC_URL), not from the request — a Host
// header the deployment accepts must never be able to aim the token at
// somebody else's domain (INV-09). F9: with no valid APP_PUBLIC_URL configured
// and EMAIL_DEV_MODE off, NO token link is built at all — null means fail
// closed (see src/shared/public-url.ts).
const tokenOrigin = (c: { env: Env; req: { url: string } }) => publicOriginStrict(c.env, c.req.url);

// Explicit 404 — self-signup does not exist (accounts are admin-created); the
// explicit route keeps unmatched-path middleware from answering instead.
authRoutes.post('/auth/signup', () => jsonError(404, 'not_found', 'unknown API route'));

// ---------- verify email (FR-A1) ----------
authRoutes.post('/auth/verify-email', async (c) => {
  // unauthenticated + does a DB read per call — IP-keyed limit
  const rl = await rateLimitHit(c.env, rateRules(c.env).tokenIp, clientIp(c, c.env) ?? 'unknown');
  if (rl) return tooMany(rl);
  const parsed = verifyEmailSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid token');
  const hash = await sha256Hex(parsed.data.token);
  // F14: consume-then-act — the token is claimed ATOMICALLY (D1 serializes
  // writes per row), so two concurrent uses of one link cannot both pass a
  // check-then-delete. Only a returned, unexpired row authorizes the change;
  // an expired one is consumed too (it is worthless either way) and answered
  // identically to today.
  const claimed = await c.env.DB.prepare(
    `DELETE FROM email_tokens WHERE token_hash = ?1 AND purpose = 'verify' RETURNING user_id, expires_at`,
  )
    .bind(hash)
    .first<{ user_id: string; expires_at: number }>();
  if (!claimed || claimed.expires_at < Date.now())
    return jsonError(422, 'invalid_token', 'this verification link is invalid or has expired');
  await c.env.DB.prepare('UPDATE users SET email_verified_at = ?1, updated_at = ?1 WHERE id = ?2')
    .bind(Date.now(), claimed.user_id)
    .run();
  return c.json({ ok: true });
});

// ---------- resend verification email (FR-A1; legacy accounts with a mailbox) ----------
// Admin-created users are pre-verified and have no mailbox — this endpoint
// backs the app's verification banner for legacy accounts with a mailbox.
authRoutes.post('/auth/resend-verification', requireAuth, async (c) => {
  const user = c.get('user');
  // F15: realEmail is the one address derivation — `user.email` may hold the
  // user's '@'-free username (no mailbox)
  const email = realEmail(user);
  if (!email) return jsonError(422, 'no_email', 'this account has no email address to verify');
  if (user.email_verified_at) return c.json({ ok: true }); // already verified

  // Layered like reset-request: the per-IP fan-out budget first, then the
  // per-address one. No challenge here — this route is requireAuth (a known,
  // admin-created account) and there is no self-signup, so the abuse it guards
  // is mail volume from a compromised session, not anonymous spraying; adding
  // a captcha widget here would cost a real user a click for no threat
  // reduction. The per-IP budget is what bounds the volume.
  const rlIp = await rateLimitHit(c.env, rateRules(c.env).resetIp, clientIp(c, c.env) ?? 'unknown');
  if (rlIp) return tooMany(rlIp);
  const rl = await rateLimitHit(c.env, rateRules(c.env).resetEmail, email);
  if (rl) return tooMany(rl);

  // F9 fail-closed: no configured origin → no token link may be built. Unlike
  // reset-request this route is authenticated (nothing to enumerate), so the
  // caller gets the truth instead of a silent no-op.
  const origin = tokenOrigin(c);
  if (!origin) {
    console.warn(
      JSON.stringify({
        evt: 'SECURITY_public_url_unset',
        at: Date.now(),
        message:
          'APP_PUBLIC_URL is unset/invalid and EMAIL_DEV_MODE is off — verification mail is REFUSED (fail-closed, F9). Set APP_PUBLIC_URL so token links use the canonical origin.',
      }),
    );
    return jsonError(503, 'mail_unconfigured', 'outbound mail is not configured on this deployment');
  }

  const token = randomToken(32);
  await c.env.DB.prepare(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, 'verify', ?3)`,
  )
    .bind(await sha256Hex(token), user.id, Date.now() + 48 * 3600_000)
    .run();
  const link = `${origin}/verify?token=${token}`;
  try {
    await getEmailSender(c.env).send(
      email,
      'Verify your TimeKeep email',
      `Verify your email address (valid 48 hours):\n${link}`,
    );
  } catch {
    /* logged by sender */
  }
  return c.json({ ok: true });
});

// ---------- login (FR-A2) ----------
authRoutes.post('/auth/login', async (c) => {
  const ip = clientIp(c, c.env) ?? 'unknown';
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  const identifier = parsed.data.identifier;

  // Order matters (the audit's #2): the coarse per-IP limit runs FIRST, so
  // obvious flood traffic is cheap to shed, but the per-identifier budgets are
  // only charged to requests that already solved the bot challenge. Charging
  // them before Turnstile let an unauthenticated attacker lock any known
  // username out of its budget without ever passing the challenge — which is
  // the one thing the challenge is there to stop.
  const rlIp = await rateLimitHit(c.env, rateRules(c.env).loginIp, ip);
  if (rlIp) return tooMany(rlIp);
  if (!(await verifyTurnstile(c.env, parsed.data.turnstile, ip)))
    return jsonError(422, 'turnstile', 'captcha verification failed');
  // F6: TWO identifier-keyed budgets, not one identifier-wide counter.
  // The pair (identifier, ip) bounds one source; the identifier-wide ceiling
  // bounds a distributed attack at 4× the pair. A single attacker can no
  // longer lock a known username out of the victim's own network.
  const rlUserIp = await rateLimitHit(c.env, rateRules(c.env).loginUserIp, `${identifier}:${ip}`);
  if (rlUserIp) return tooMany(rlUserIp);
  const rlIdentity = await rateLimitHit(c.env, rateRules(c.env).loginIdentity, identifier);
  if (rlIdentity) return tooMany(rlIdentity);

  const user = await c.env.DB.prepare(
    `SELECT id, username, password_hash, role, active, must_change_password FROM users
     WHERE username = ?1 OR email = ?1 COLLATE NOCASE`,
  )
    .bind(identifier)
    .first<{
      id: string;
      username: string;
      password_hash: string | null;
      role: 'user' | 'admin';
      active: 0 | 1;
      must_change_password: 0 | 1;
    }>();

  let ok = false;
  if (user?.password_hash) {
    ok = await verifyPassword(parsed.data.password, user.password_hash);
  } else {
    // burn comparable time so missing accounts aren't distinguishable by latency.
    // A NULL password_hash (migration 0012 removed the seeded admin credential —
    // F5) lands here too: it must be indistinguishable from an unknown account,
    // which is why there is no separate "credential not set up" error.
    await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS));
  }

  if (!user || !ok) {
    // generic message — no account enumeration (FR-A2 AC)
    return jsonError(401, 'invalid_credentials', 'invalid username or password');
  }
  if (!user.active) {
    return jsonError(403, 'account_disabled', 'this account has been deactivated — contact your administrator');
  }

  const now = Date.now();
  const token = randomToken(32);
  await c.env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      await sha256Hex(token),
      c.req.header('user-agent') ?? '',
      ip,
      now,
      now + SESSION_TTL_MS,
    )
    .run();
  setSessionCookie(c, token, now + SESSION_TTL_MS);
  issueCsrfCookie(c);
  return c.json({
    ok: true,
    user_id: user.id,
    role: user.role,
    must_change_password: !!user.must_change_password,
  });
});

// ---------- logout ----------
authRoutes.post('/auth/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1').bind(c.get('authSessionId')).run();
  // audit S1 parity: this session's socket must die with its session row
  revokeHub(c.env, c.get('user').id, { only: c.get('authSessionId') });
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- password reset (FR-A5, no enumeration) ----------
authRoutes.post('/auth/reset-request', async (c) => {
  const parsed = resetRequestSchema.safeParse(await c.req.json().catch(() => null));
  // A malformed body gets the same shape-identical ok:true, so it must not
  // consume any budget either — otherwise a probe could burn a victim's
  // per-address or the caller's per-IP reset allowance for free.
  if (!parsed.success) return c.json({ ok: true });
  const email = parsed.data.email;
  const ip = clientIp(c, c.env) ?? 'unknown';
  // Order mirrors login: the coarse per-IP budget runs FIRST (it is the only
  // thing that bounds a fan-out over MANY addresses — the audit's #11), then the
  // bot challenge, then the per-address budget. A challenge failure must not
  // spend the victim's mailbox allowance either.
  const rlIp = await rateLimitHit(c.env, rateRules(c.env).resetIp, ip);
  if (rlIp) return tooMany(rlIp);
  if (!(await verifyTurnstile(c.env, parsed.data.turnstile, ip)))
    return jsonError(422, 'turnstile', 'captcha verification failed');
  const rl = await rateLimitHit(c.env, rateRules(c.env).resetEmail, email);
  if (rl) return tooMany(rl);

  const user = await c.env.DB.prepare(
    'SELECT id, email, login_email, email_verified_at, role, active FROM users WHERE email = ?1',
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      login_email: string | null;
      email_verified_at: number | null;
      role: 'user' | 'admin';
      active: 0 | 1;
    }>();
  // F15: the mailbox comes from realEmail — the input can be the user's
  // '@'-free username (the legacy email mirror matches it), and a pre-verified
  // user without a mailbox must take the skip branch, not receive mail
  const mailTo = realEmail(user);

  // Identical response AND comparable wall-clock time whether or not the account
  // exists (FR-A5 AC, audit #3): the send moved onto waitUntil so the real path
  // no longer waits on an outbound fetch (100 ms+), and every skip branch burns
  // the same token work the real path does — `POST /auth/login` already does
  // this for unknown users. Residual, stated rather than hidden: the real path
  // still performs one extra D1 insert (~1 ms).
  if (!user || user.role === 'admin' || !user.active || !user.email_verified_at || !mailTo) {
    await sha256Hex(randomToken(32)); // admin has no mailbox; unverified is blocked (FR-A1)
    return c.json({ ok: true });
  }
  // F9 fail-closed: without a configured APP_PUBLIC_URL (and outside
  // EMAIL_DEV_MODE) no token link may be built — a reset email is a bearer
  // credential, and this route must not leak whether mail went out either.
  // Same shape AND comparable token work as the sendable path; the
  // misconfiguration is logged for the operator instead.
  const origin = tokenOrigin(c);
  if (!origin) {
    await sha256Hex(randomToken(32));
    console.warn(
      JSON.stringify({
        evt: 'SECURITY_public_url_unset',
        at: Date.now(),
        message:
          'APP_PUBLIC_URL is unset/invalid and EMAIL_DEV_MODE is off — password-reset mail is REFUSED (fail-closed, F9). Set APP_PUBLIC_URL so token links use the canonical origin.',
      }),
    );
    return c.json({ ok: true });
  }
  const token = randomToken(32);
  await c.env.DB.prepare(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, 'reset', ?3)`,
  )
    .bind(await sha256Hex(token), user.id, Date.now() + 3600_000)
    .run();
  const link = `${origin}/reset?token=${token}`;
  c.executionCtx.waitUntil(
    getEmailSender(c.env)
      .send(
        mailTo,
        'Reset your TimeKeep password',
        `Reset your password (valid 1 hour):\n${link}\n\nAll active sessions will be signed out.`,
      )
      .catch(() => {
        /* logged by sender */
      }),
  );
  // No reset link in the response even under EMAIL_DEV_MODE — the dev console
  // log is the dev surface; API responses must never carry live tokens.
  return c.json({ ok: true });
});

authRoutes.post('/auth/reset-confirm', async (c) => {
  // unauthenticated + does a DB read per call — IP-keyed limit
  const rl = await rateLimitHit(c.env, rateRules(c.env).tokenIp, clientIp(c, c.env) ?? 'unknown');
  if (rl) return tooMany(rl);
  const parsed = resetConfirmSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  const pwProblem = passwordProblem(parsed.data.password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  const hash = await sha256Hex(parsed.data.token);
  // F14: consume-then-act (same as verify-email) — the DELETE claims the token
  // atomically before anything else happens; a concurrent second use finds no
  // row and gets the same invalid_token as a replayed link.
  const claimed = await c.env.DB.prepare(
    `DELETE FROM email_tokens WHERE token_hash = ?1 AND purpose = 'reset' RETURNING user_id, expires_at`,
  )
    .bind(hash)
    .first<{ user_id: string; expires_at: number }>();
  if (!claimed || claimed.expires_at < Date.now())
    return jsonError(422, 'invalid_token', 'this reset link is invalid or has expired');

  const now = Date.now();
  const password_hash = await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS));
  // reset revokes ALL existing sessions (FR-A5). The claimed token is already
  // consumed — the cleanup now sweeps the user's OTHER reset tokens, so any
  // sibling link minted before this one dies with it.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3').bind(
      password_hash,
      now,
      claimed.user_id,
    ),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'reset'").bind(claimed.user_id),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(claimed.user_id),
  ]);
  revokeHub(c.env, claimed.user_id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
