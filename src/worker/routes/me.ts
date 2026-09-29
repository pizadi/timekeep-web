// FR-A6/A7/A8: profile, per-user settings surface, session management, account deletion.
import { Hono } from 'hono';
import type { WorkerType, UserInfo } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitWrites, clearSessionCookie } from '../middleware';
import { profilePatchSchema, passwordChangeSchema } from '../validators';
import { isValidTimezone } from '../../shared/time';
import { passwordProblem } from '../../shared/validation';
import { commitWithEvents, wipeHub, revokeHub, EventDraft } from '../events';
import { hashPassword, verifyPassword, isCommonPassword } from '../auth';

export const meRoutes = new Hono<WorkerType>();
// scoped — a sub-app use('*') would leak requireAuth onto every /api path
meRoutes.use('/me', requireAuth, limitWrites);
meRoutes.use('/me/*', requireAuth, limitWrites);

const publicUser = (u: any): UserInfo => ({
  id: u.id,
  username: u.username,
  email: u.email,
  name: u.name,
  timezone: u.timezone,
  week_start: u.week_start,
  theme: u.theme,
  role: u.role,
  must_change_password: !!u.must_change_password,
  email_verified_at: u.email_verified_at,
  created_at: u.created_at,
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
  if (u.name !== undefined) {
    sets.push('name = ?');
    binds.push(u.name);
  }
  if (u.timezone !== undefined) {
    sets.push('timezone = ?');
    binds.push(u.timezone);
  }
  if (u.week_start !== undefined) {
    // effective week start (0=Sun…6=Sat) lives in week_start_dow; the legacy
    // 0|1 column is kept in sync when possible for export compatibility
    sets.push('week_start_dow = ?');
    binds.push(u.week_start);
    sets.push('week_start = CASE WHEN ? IN (0, 1) THEN ? ELSE week_start END');
    binds.push(u.week_start, u.week_start);
  }
  if (u.theme !== undefined) {
    sets.push('theme = ?');
    binds.push(u.theme);
  }
  if (sets.length === 0) return c.json({ user: publicUser(c.get('user')) });

  sets.push('updated_at = ?');
  binds.push(Date.now(), c.get('user').id);

  // timezone/theme changes sync to other devices (FR-A7 AC, FR-U1). The UPDATE
  // and the event share ONE batch (INV-11) — a profile change with no event
  // would leave other devices on the old timezone/theme indefinitely, since
  // the sync poll only walks the event cursor.
  const drafts: EventDraft[] = [{ type: 'settings.updated', actor: c.get('deviceId'), data: { profile: u } }];
  await commitWithEvents(c.env, c.get('user').id, drafts, [
    c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds),
  ]);

  const fresh = await c.env.DB.prepare(
    `SELECT id, username, email, name, timezone, COALESCE(week_start_dow, week_start) AS week_start,
            theme, role, must_change_password, email_verified_at, created_at
     FROM users WHERE id = ?1`,
  )
    .bind(c.get('user').id)
    .first();
  return c.json({ user: publicUser(fresh) });
});

// ---------- change password (also clears must_change_password) ----------
meRoutes.post('/me/password', async (c) => {
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');

  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1')
    .bind(user.id)
    .first<{ password_hash: string | null }>();
  if (!row?.password_hash || !(await verifyPassword(parsed.data.current_password, row.password_hash)))
    return jsonError(403, 'bad_password', 'current password is incorrect');

  const pwProblem = passwordProblem(parsed.data.password, isCommonPassword);
  if (pwProblem) return jsonError(422, 'validation', pwProblem);

  // keep the current session, revoke every other one
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?1, must_change_password = 0, updated_at = ?2 WHERE id = ?3',
    ).bind(await hashPassword(parsed.data.password, Number(c.env.PBKDF2_ITERATIONS)), Date.now(), user.id),
    c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND id <> ?2').bind(user.id, c.get('authSessionId')),
  ]);
  // audit S1: the D1 deletes alone leave revoked devices' WebSockets live —
  // close them, sparing the acting device's own session/socket
  revokeHub(c.env, user.id, { keep: c.get('authSessionId') });
  return c.json({ ok: true });
});

/** Hard delete: FK cascades remove every user-owned row (FR-A8, NFR-4). */
meRoutes.delete('/me', async (c) => {
  // the admin account must not be deletable — with no self-signup, deleting it
  // would leave the installation permanently locked out
  if (c.get('user').role === 'admin') return jsonError(403, 'forbidden', 'the admin account cannot be deleted');
  const userId = c.get('user').id;
  const now = Date.now();
  // deletion request log (route + user id only — NFR-3 log hygiene)
  console.log(JSON.stringify({ evt: 'account_delete_requested', user_id: userId, at: new Date().toISOString() }));

  // Audit F1: the hand-written list below missed `goals`, `groups.owner_id`,
  // `group_invites.invited_by` and `group_invite_links.created_by` — FKs to
  // users(id) with NO ON DELETE action — so the final `DELETE FROM users`
  // violated a constraint and the whole (atomic) batch 500'd: any user with a
  // goal, an owned group, or a sent invite/link could never delete their
  // account. Audit F2: the deleter's shared rows must not cascade-destroy
  // OTHER members' history either — group projects/tasks keep their creator
  // in `user_id`, and deleting those rows cascades every member's sessions.
  //
  // Resolution (owner decision D1):
  //  - a group they own WITH remaining active members is transferred to the
  //    earliest-joined one, and the deleter's shared rows move to that owner;
  //  - a group they own with no one left is deleted the way DELETE /groups/:id
  //    does it (tombstone tasks, detach + tombstone projects) — no cascade;
  //  - everything runs in ONE atomic batch, in dependency order. Table
  //    rebuilds to add ON DELETE CASCADE are NOT an option (D1 gotcha).
  const ownedGroups = await c.env.DB.prepare('SELECT id FROM groups WHERE owner_id = ?1')
    .bind(userId)
    .all<{ id: string }>();
  const batch: D1PreparedStatement[] = [];
  for (const g of ownedGroups.results) {
    const succ = await c.env.DB.prepare(
      `SELECT gm.user_id AS user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?1 AND gm.user_id <> ?2 AND u.active = 1
       ORDER BY gm.created_at, gm.user_id LIMIT 1`,
    )
      .bind(g.id, userId)
      .first<{ user_id: string }>();
    if (succ) {
      batch.push(
        c.env.DB.prepare('UPDATE groups SET owner_id = ?2, updated_at = ?3 WHERE id = ?1').bind(
          g.id,
          succ.user_id,
          now,
        ),
        c.env.DB.prepare("UPDATE group_members SET role = 'owner' WHERE group_id = ?1 AND user_id = ?2").bind(
          g.id,
          succ.user_id,
        ),
        c.env.DB.prepare(
          "UPDATE group_members SET role = 'member' WHERE group_id = ?1 AND user_id = ?2 AND role = 'owner'",
        ).bind(g.id, userId),
      );
    } else {
      // solo group (no other active member): the same safe-delete procedure as
      // DELETE /groups/:id — history survives, the group itself goes
      batch.push(
        c.env.DB.prepare(
          `UPDATE tasks SET deleted_at = ?2, updated_at = ?2
           WHERE deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE group_id = ?1)`,
        ).bind(g.id, now),
        c.env.DB.prepare(
          `UPDATE projects SET group_id = NULL, deleted_at = ?2, updated_at = ?2
           WHERE group_id = ?1 AND deleted_at IS NULL`,
        ).bind(g.id, now),
        c.env.DB.prepare('DELETE FROM groups WHERE id = ?1').bind(g.id), // cascades members/invites/links
      );
    }
  }
  // Shared rows the deleter created inside groups that SURVIVE them are
  // reassigned to the group's owner — who cannot be the deleter here, because
  // every owned group was either transferred or deleted above. The
  // denormalized user_id on the shared entities must follow: every live
  // ownership check filters on it. Projects detached by the solo-group delete
  // no longer match (`group_id IS NULL`), so the subselect never misses.
  batch.push(
    c.env.DB.prepare(
      `UPDATE projects SET user_id = (SELECT owner_id FROM groups WHERE id = projects.group_id), updated_at = ?2
       WHERE user_id = ?1 AND group_id IS NOT NULL`,
    ).bind(userId, now),
    c.env.DB.prepare(
      `UPDATE tasks SET
         user_id = (SELECT owner_id FROM groups WHERE id = (SELECT group_id FROM projects WHERE id = tasks.project_id)),
         updated_at = ?2
       WHERE user_id = ?1 AND project_id IN (SELECT id FROM projects WHERE group_id IS NOT NULL)`,
    ).bind(userId, now),
    c.env.DB.prepare(
      `UPDATE subtasks SET user_id = (SELECT owner_id FROM groups WHERE id = (SELECT group_id FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = subtasks.task_id)))
       WHERE user_id = ?1 AND task_id IN (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE group_id IS NOT NULL))`,
    ).bind(userId),
    c.env.DB.prepare(
      `UPDATE task_dependencies SET user_id = (SELECT owner_id FROM groups WHERE id = (SELECT group_id FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = task_dependencies.task_id)))
       WHERE user_id = ?1 AND task_id IN (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE group_id IS NOT NULL))`,
    ).bind(userId),
  );
  // the FKs with no ON DELETE action (audit F1) — explicit, before `users`
  batch.push(
    c.env.DB.prepare('DELETE FROM goals WHERE user_id = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM group_invite_links WHERE created_by = ?1').bind(userId),
    c.env.DB.prepare('DELETE FROM group_invites WHERE invited_by = ?1').bind(userId),
  );
  batch.push(
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
    c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  );
  await c.env.DB.batch(batch);
  clearSessionCookie(c);
  // the D1 deletes alone leave the user's WebSockets live and the DO's private
  // pomodoro storage intact — close the sockets and wipe the storage (the DO
  // id is the user id, so nothing here can belong to anyone else; audit F1)
  wipeHub(c.env, userId);
  return c.json({ ok: true });
});

meRoutes.get('/me/sessions', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
     FROM auth_sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC`,
  )
    .bind(c.get('user').id)
    .all<any>();
  const currentId = c.get('authSessionId');
  return c.json({
    sessions: rows.results.map((s) => ({ ...s, current: s.id === currentId })),
  });
});

meRoutes.delete('/me/sessions/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?1 AND user_id = ?2').bind(id, c.get('user').id).run();
  // audit S1: if this was a live device, its socket must die too (selective —
  // deleting the current session's own row kills only this session's sockets)
  revokeHub(c.env, c.get('user').id, { only: id });
  return c.json({ ok: true });
});

meRoutes.post('/me/sessions/revoke-others', async (c) => {
  await c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND id <> ?2')
    .bind(c.get('user').id, c.get('authSessionId'))
    .run();
  revokeHub(c.env, c.get('user').id, { keep: c.get('authSessionId') });
  return c.json({ ok: true });
});
