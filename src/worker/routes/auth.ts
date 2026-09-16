// FR-A: login, logout, password reset (no enumeration), all rate-limited per
// NFR-3. Self-signup is intentionally absent — accounts are created by the
// admin (routes/admin.ts); the initial admin is seeded by migration 0002.
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { hashPassword, verifyPassword, randomToken, sha256Hex, getEmailSender, isCommonPassword } from '../auth';
import {
  requireAuth, setSessionCookie, clearSessionCookie, clientIp,
  rateLimitHit, tooMany, rateRules, verifyTurnstile, issueCsrfCookie
} from '../middleware';

import { loginSchema, verifyEmailSchema, resetRequestSchema, resetConfirmSchema } from '../validators';
import { isValidEmail, passwordProblem } from '../../shared/validation';
import { SESSION_TTL_MS } from '../../shared/constants';

export const authRoutes = new Hono<WorkerType>();

const appUrl = (c: { req: { url: string } }) => new URL(c.req.url).origin;

// Explicit 404 — self-signup does not exist (accounts are admin-created); the
// explicit route keeps unmatched-path middleware from answering instead.
authRoutes.post('/auth/signup', (c) => jsonError(404, 'not_found', 'unknown API route'));

// ---------- verify email (FR-A1) ----------
authRoutes.post('/auth/verify-email', async (c) => {
  const parsed = verifyEmailSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid token');
  const hash = await sha256Hex(parsed.data.token);
  const row = await c.env.DB.prepare(
    `SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ?1 AND purpose = 'verify'`
  ).bind(hash).first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now())
    return jsonError(422, 'invalid_token', 'this verification link is invalid or has expired');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET email_verified_at = ?1, updated_at = ?1 WHERE id = ?2')
      .bind(Date.now(), row.user_id),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?1").bind(hash)
  ]);
  return c.json({ ok: true });
});

// ---------- login (FR-A2) ----------
authRoutes.post('/auth/login', async (c) => {
  const ip = clientIp(c) ?? 'unknown';
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  const identifier = parsed.data.identifier;

  const rlIp = await rateLimitHit(c.env, rateRules(c.env).loginIp, ip);
  const rlLogin = await rateLimitHit(c.env, rateRules(c.env).loginEmail, identifier);
  if (rlIp) return tooMany(rlIp);
  if (rlLogin) return tooMany(rlLogin);
  if (!(await verifyTurnstile(c.env, parsed.data.turnstile, ip)))
    return jsonError(422, 'turnstile', 'captcha verification failed');

  const user = await c.env.DB.prepare(
    `SELECT id, username, password_hash, role, active, must_change_password FROM users
     WHERE username = ?1 OR email = ?1 COLLATE NOCASE`
  ).bind(identifier).first<{
    id: string; username: string; password_hash: string | null;
    role: 'user' | 'admin'; active: 0 | 1; must_change_password: 0 | 1;
  }>();

  let ok = false;
  if (user?.password_hash) {
    ok = await verifyPassword(parsed.data.password, user.password_hash);
  } else {
    // burn comparable time so missing accounts aren't distinguishable by latency
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
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`
  ).bind(crypto.randomUUID(), user.id, await sha256Hex(token),
    c.req.header('user-agent') ?? '', ip, now, now + SESSION_TTL_MS).run();
  setSessionCookie(c, token, now + SESSION_TTL_MS);
  issueCsrfCookie(c);
  return c.json({
    ok: true,
    user_id: user.id,
    role: user.role,
    must_change_password: !!user.must_change_password
  });
});

// ---------- logout ----------
authRoutes.post('/auth/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1')
    .bind(c.get('authSessionId')).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- password reset (FR-A5, no enumeration) ----------
authRoutes.post('/auth/reset-request', async (c) => {
  const parsed = resetRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: true }); // shape-identical response anyway
  const email = parsed.data.email;
  const rl = await rateLimitHit(c.env, rateRules(c.env).resetEmail, email);
  if (rl) return tooMany(rl);
  if (!(await verifyTurnstile(c.env, parsed.data.turnstile, clientIp(c))))
    return jsonError(422, 'turnstile', 'captcha verification failed');

  const user = await c.env.DB.prepare(
    'SELECT id, email_verified_at, role, active FROM users WHERE email = ?1'
  ).bind(email).first<{ id: string; email_verified_at: number | null; role: 'user' | 'admin'; active: 0 | 1 }>();
  let devLink: string | undefined;
  if (user) {
    // admin has no mailbox; deactivated accounts can't log in anyway
    if (user.role === 'admin' || !user.active) return c.json({ ok: true });
    if (!user.email_verified_at) {
      // blocked until verified (FR-A1)
      return c.json({ ok: true });
    }
    const token = randomToken(32);
    await c.env.DB.prepare(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, 'reset', ?3)`
    ).bind(await sha256Hex(token), user.id, Date.now() + 3600_000).run();
    const link = `${appUrl(c)}/reset?token=${token}`;
    try {
      await getEmailSender(c.env).send(email, 'Reset your TimeKeep password',
        `Reset your password (valid 1 hour):\n${link}\n\nAll active sessions will be signed out.`);
    } catch { /* logged by sender */ }
    if (c.env.EMAIL_DEV_MODE === '1' && !c.env.RESEND_API_KEY) devLink = link;
  }
  // identical response whether or not the account exists (FR-A5 AC)
  return c.json({ ok: true, ...(devLink ? { dev_reset_url: devLink } : {}) });
});

authRoutes.post('/auth/reset-confirm', async (c) => {
  const parsed = resetConfirmSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  const pwProblem = passwordProblem(parsed.data.password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  const hash = await sha256Hex(parsed.data.token);
  const row = await c.env.DB.prepare(
    `SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ?1 AND purpose = 'reset'`
  ).bind(hash).first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now())
    return jsonError(422, 'invalid_token', 'this reset link is invalid or has expired');

  const now = Date.now();
  const password_hash = await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS));
  // reset revokes ALL existing sessions (FR-A5)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(password_hash, now, row.user_id),
    c.env.DB.prepare("DELETE FROM email_tokens WHERE token_hash = ?1 OR user_id = ?2 AND purpose = 'reset'")
      .bind(hash, row.user_id),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.user_id)
  ]);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
