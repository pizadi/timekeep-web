// Admin: user management — list, create, deactivate/reactivate, reset password.
// Self-signup does not exist; accounts are only created here. The seeded admin
// cannot be deactivated and cannot delete accounts (deactivation only).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, requireAdmin, rateLimitHit, rateRules, tooMany, clientIp } from '../middleware';
import { adminCreateSchema, adminPatchSchema, adminResetSchema } from '../validators';
import { isValidEmail, passwordProblem } from '../../shared/validation';
import { hashPassword, isCommonPassword } from '../auth';
import { isUniqueConstraintError } from '../rules';
import { revokeHub } from '../events';
import { ulid } from '../../shared/ids';

export const adminRoutes = new Hono<WorkerType>();
// scoped to /admin/* — a sub-app use('*') would leak requireAdmin onto every
// /api path mounted after this one (Hono merges sub-app middleware globally)
adminRoutes.use('/admin/*', requireAuth, requireAdmin);


// Admin mutations pay a full PBKDF2 (600k iterations in prod) — IP-keyed
// and env-overridable.
async function limitAdmin(c: any): Promise<Response | null> {
  const rl = await rateLimitHit(c.env, rateRules(c.env).adminIp, clientIp(c) ?? 'unknown');
  return rl ? tooMany(rl) : null;
}

adminRoutes.get('/admin/users', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, username, email, name, role, active, must_change_password, email_verified_at, created_at
     FROM users ORDER BY created_at`
  ).all<any>();
  return c.json({
    users: rows.results.map((u) => ({ ...u, must_change_password: !!u.must_change_password }))
  });
});

adminRoutes.post('/admin/users', async (c) => {
  const limited = await limitAdmin(c);
  if (limited) return limited;
  const parsed = adminCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload', parsed.error.flatten());
  const { username, name, email, password } = parsed.data;

  if (email && !isValidEmail(email)) return jsonError(422, 'validation', 'invalid email address');
  const pwProblem = passwordProblem(password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  const now = Date.now();
  const id = ulid(now);
  try {
    // users without a real email store their (unique, '@'-free) username in the
    // email column — it doubles as the legacy unique login identifier
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, username, password_hash, name, timezone, week_start, theme,
                          role, active, must_change_password, email_verified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'UTC', 1, 'system', 'user', 1, 1, ?6, ?6, ?6)`
    ).bind(id, email ?? username, username,
      await hashPassword(password, Number(c.env.PBKDF2_ITERATIONS)), name, now).run();
  } catch (e: any) {
    if (isUniqueConstraintError(e))
      return jsonError(409, 'conflict', 'that username or email is already taken');
    throw e;
  }
  return c.json({
    user: { id, username, email: email ?? username, name, role: 'user', active: 1, must_change_password: true }
  }, 201);
});

adminRoutes.patch('/admin/users/:id', async (c) => {
  const limited = await limitAdmin(c);
  if (limited) return limited;
  const id = c.req.param('id');
  const parsed = adminPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');

  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?1').bind(id).first<{ id: string; role: 'user' | 'admin' }>();
  if (!target) return jsonError(404, 'not_found', 'no such user');

  if (parsed.data.active === 0) {
    if (target.role === 'admin') return jsonError(422, 'validation', 'the admin account cannot be deactivated');
    // deactivation kills every live session + socket; data is never touched
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET active = 0, updated_at = ?1 WHERE id = ?2').bind(Date.now(), id),
      c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(id)
    ]);
    revokeHub(c.env, id);
  } else {
    await c.env.DB.prepare('UPDATE users SET active = 1, updated_at = ?1 WHERE id = ?2').bind(Date.now(), id).run();
  }
  return c.json({ ok: true });
});

adminRoutes.post('/admin/users/:id/password', async (c) => {
  const limited = await limitAdmin(c);
  if (limited) return limited;
  const id = c.req.param('id');
  const parsed = adminResetSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');
  if (id === c.get('user').id)
    return jsonError(422, 'validation', 'use change-password for your own account');

  const pwProblem = passwordProblem(parsed.data.password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first();
  if (!target) return jsonError(404, 'not_found', 'no such user');

  // temp password + forced change + full sign-out
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?1, must_change_password = 1, updated_at = ?2 WHERE id = ?3'
    ).bind(await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS)), Date.now(), id),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(id)
  ]);
  revokeHub(c.env, id);
  return c.json({ ok: true });
});
