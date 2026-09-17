// FR-A6/A7/A8: profile, per-user settings surface, session management, account deletion.
import { Hono } from 'hono';
import type { WorkerType, UserInfo } from '../env';
import { jsonError } from '../env';
import { requireAuth, clearSessionCookie } from '../middleware';
import { profilePatchSchema, passwordChangeSchema } from '../validators';
import { isValidTimezone } from '../../shared/time';
import { passwordProblem } from '../../shared/validation';
import { appendEvents, notifyHub, revokeHub, EventDraft } from '../events';
import { sha256Hex, hashPassword, verifyPassword, isCommonPassword } from '../auth';

export const meRoutes = new Hono<WorkerType>();
// scoped — a sub-app use('*') would leak requireAuth onto every /api path
meRoutes.use('/me', requireAuth);
meRoutes.use('/me/*', requireAuth);

const publicUser = (u: any): UserInfo => ({
  id: u.id, username: u.username, email: u.email, name: u.name, timezone: u.timezone,
  week_start: u.week_start, theme: u.theme,
  role: u.role, must_change_password: !!u.must_change_password,
  email_verified_at: u.email_verified_at, created_at: u.created_at
});

meRoutes.get('/me', (c) => c.json({ user: publicUser(c.get('user')) }));

meRoutes.patch('/me', async (c) => {
  const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid profile payload', parsed.error.flatten());
  const u = parsed.data;
  if (u.timezone && !isValidTimezone(u.timezone))
    return jsonError(422, 'validation', 'unknown IANA timezone identifier');

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (u.name !== undefined) { sets.push('name = ?'); binds.push(u.name); }
  if (u.timezone !== undefined) { sets.push('timezone = ?'); binds.push(u.timezone); }
  if (u.week_start !== undefined) {
    // effective week start (0=Sun…6=Sat) lives in week_start_dow; the legacy
    // 0|1 column is kept in sync when possible for export compatibility
    sets.push('week_start_dow = ?'); binds.push(u.week_start);
    sets.push('week_start = CASE WHEN ? IN (0, 1) THEN ? ELSE week_start END');
    binds.push(u.week_start, u.week_start);
  }
  if (u.theme !== undefined) { sets.push('theme = ?'); binds.push(u.theme); }
  if (sets.length === 0) return c.json({ user: publicUser(c.get('user')) });

  sets.push('updated_at = ?');
  binds.push(Date.now(), c.get('user').id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  // timezone/theme changes sync to other devices (FR-A7 AC, FR-U1)
  const drafts: EventDraft[] = [{ type: 'settings.updated', actor: c.get('deviceId'), data: { profile: u } }];
  const evs = await appendEvents(c.env, c.get('user').id, drafts);
  notifyHub(c.env, c.get('user').id, evs, c.executionCtx);

  const fresh = await c.env.DB.prepare(
    `SELECT id, username, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start,
            theme, role, must_change_password, email_verified_at, created_at
     FROM users WHERE id = ?1`
  ).bind(c.get('user').id).first();
  return c.json({ user: publicUser(fresh) });
});

// ---------- change password (also clears must_change_password) ----------
meRoutes.post('/me/password', async (c) => {
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');

  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id).first<{ password_hash: string | null }>();
  if (!row?.password_hash || !(await verifyPassword(parsed.data.current_password, row.password_hash)))
    return jsonError(403, 'bad_password', 'current password is incorrect');

  const pwProblem = passwordProblem(parsed.data.password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  // keep the current session, revoke every other one
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?1, must_change_password = 0, updated_at = ?2 WHERE id = ?3'
    ).bind(await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS)), Date.now(), user.id),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND id <> ?2')
      .bind(user.id, c.get('authSessionId'))
  ]);
  return c.json({ ok: true });});

/** Hard delete: FK cascades remove every user-owned row (FR-A8, NFR-4). */
meRoutes.delete('/me', async (c) => {
  // the admin account must not be deletable — with no self-signup, deleting it
  // would leave the installation permanently locked out
  if (c.get('user').role === 'admin')
    return jsonError(403, 'forbidden', 'the admin account cannot be deleted');
  const userId = c.get('user').id;
  const now = new Date().toISOString();
  // deletion request log (route + user id only — NFR-3 log hygiene)
  console.log(JSON.stringify({ evt: 'account_delete_requested', user_id: userId, at: now }));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sync_log WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM active_timers WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM layout WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM settings WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM time_sessions WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM task_dependencies WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM subtasks WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM tasks WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM projects WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM oauth_accounts WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId)
  ]);
  clearSessionCookie(c);
  revokeHub(c.env, userId);
  return c.json({ ok: true });
});

meRoutes.get('/me/sessions', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
     FROM auth_sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC`
  ).bind(c.get('user').id).all<any>();
  const currentId = c.get('authSessionId');
  return c.json({
    sessions: rows.results.map((s) => ({ ...s, current: s.id === currentId }))
  });
});

meRoutes.delete('/me/sessions/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1 AND user_id = ?2')
    .bind(id, c.get('user').id).run();
  return c.json({ ok: true });
});

meRoutes.post('/me/sessions/revoke-others', async (c) => {
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND id <> ?2')
    .bind(c.get('user').id, c.get('authSessionId')).run();
  return c.json({ ok: true });
});
