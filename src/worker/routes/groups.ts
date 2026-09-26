// Social layer, phase 2: groups, membership, fine-grained permissions,
// username invites + token invite links.
// Authorization lives in group-auth.ts (loadGroupContext / requireGroupPerm);
// every mutation signals all current members via a sync_log event per
// recipient (emitToUsers) — clients refetch the group lists on `group.*`.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitWrites, rateLimitHit, rateRules } from '../middleware';
import {
  groupCreateSchema, groupPatchSchema, groupInviteSchema,
  groupMemberPatchSchema, groupLinkCreateSchema, ulidish
} from '../validators';
import { emitToUsers, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { randomToken, sha256Hex } from '../auth';
import { isUniqueConstraintError } from '../rules';
import { requireGroup, requireGroupPerm } from '../group-auth';
import { dayBounds, civilDate, minutes } from '../../shared/time';
import { LIMITS, REPORT_MAX_RANGE_DAYS } from '../../shared/constants';

export const groupRoutes = new Hono<WorkerType>();
groupRoutes.use('/groups', requireAuth, limitWrites);
groupRoutes.use('/groups/*', requireAuth, limitWrites);

/** Signal every current member (+ any extra users, e.g. an invitee) that the
 *  group changed. Group events are deliberately payload-light: clients refetch. */
async function emitToGroup(
  env: Env, groupId: string, draft: EventDraft, extraUserIds: string[] = [],
  ctx?: { waitUntil(p: Promise<unknown>): void }
): Promise<void> {
  const members = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?1')
    .bind(groupId).all<{ user_id: string }>();
  const ids = new Set<string>([...members.results.map((m) => m.user_id), ...extraUserIds]);
  await emitToUsers(env, [...ids].map((userId) => ({ userId, draft })), ctx);
}

// ---------- list ----------

/** Groups + pending invites, shared by GET /groups and GET /bootstrap. */
export async function groupLists(db: D1Database, userId: string) {
  const [groups, invites] = await Promise.all([
    db.prepare(
      `SELECT g.id, g.name, g.color, g.owner_id, m.role, m.perms, g.created_at,
              (SELECT COUNT(*) FROM group_members cm JOIN users cu ON cu.id = cm.user_id
               WHERE cm.group_id = g.id AND cu.active = 1) AS member_count,
              (SELECT COUNT(*) FROM group_messages gm
               WHERE gm.group_id = g.id AND gm.deleted_at IS NULL
                 AND gm.sender_id != m.user_id AND gm.created_at > m.last_read_at) AS unread
       FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?1
       ORDER BY g.created_at`
    ).bind(userId).all(),
    db.prepare(
      `SELECT i.id AS invite_id, i.created_at, g.id AS group_id, g.name, g.color,
              u.username AS inviter_username, u.name AS inviter_name
       FROM group_invites i
       JOIN groups g ON g.id = i.group_id
       JOIN users u ON u.id = i.invited_by
       WHERE i.invitee_id = ?1 AND i.status = 'pending'
       ORDER BY i.created_at`
    ).bind(userId).all()
  ]);
  return { groups: groups.results, incoming_invites: invites.results };
}

groupRoutes.get('/groups', async (c) => {
  return c.json(await groupLists(c.env.DB, c.get('user').id));
});

groupRoutes.post('/groups', async (c) => {
  const parsed = groupCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid group payload', parsed.error.flatten());
  const me = c.get('user').id;

  const now = Date.now();
  const id = ulid(now);
  const color = parsed.data.color ?? '#4f8cff';
  // Capacity is enforced INSIDE the insert, not by a prior SELECT COUNT: D1
  // serializes writes per database, so a concurrent create can't slip past a
  // count taken microseconds earlier (audit 🟡2 TOCTOU).
  const ins = await c.env.DB.prepare(
    `INSERT INTO groups (id, name, color, owner_id, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?5
     WHERE (SELECT COUNT(*) FROM group_members WHERE user_id = ?4) < ?6`
  ).bind(id, parsed.data.name, color, me, now, LIMITS.groupsPerUser).run();
  if (Number(ins.meta.changes ?? 0) !== 1)
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.groupsPerUser} groups per account`);
  // owner membership second: the group id is brand new, so nothing can race here
  await c.env.DB.prepare("INSERT INTO group_members (group_id, user_id, role, perms, created_at) VALUES (?1, ?2, 'owner', '', ?3)")
    .bind(id, me, now).run();
  const group = await c.env.DB.prepare('SELECT id, name, color, owner_id, created_at, updated_at FROM groups WHERE id = ?1')
    .bind(id).first();
  await emitToUsers(c.env, [{ userId: me, draft: { type: 'group.created', actor: c.get('deviceId'), data: { group_id: id } } }], c.executionCtx);
  return c.json({ group }, 201);
});

// ---------- join by link (token capability) ----------

groupRoutes.post('/groups/join', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsed = z.object({ token: z.string().min(16).max(256) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid token');
  const me = c.get('user').id;

  const tokenHash = await sha256Hex(parsed.data.token);
  const link = await c.env.DB.prepare(
    `SELECT l.id AS link_id, g.id AS group_id FROM group_invite_links l
     JOIN groups g ON g.id = l.group_id
     WHERE l.token_hash = ?1 AND l.revoked_at IS NULL
       AND (l.expires_at IS NULL OR l.expires_at > ?2)
       AND (l.max_uses IS NULL OR l.use_count < l.max_uses)`
  ).bind(tokenHash, Date.now()).first<{ link_id: string; group_id: string }>();
  if (!link) return jsonError(404, 'not_found', 'this invite link is invalid, expired or revoked');

  const now = Date.now();
  try {
    // Both capacity guards live in the statements themselves (audit 🟡2): the
    // member count inside the INSERT, the remaining uses inside the UPDATE, so
    // concurrent joins can't both pass a prior SELECT. In one transactional
    // batch — a duplicate join (UNIQUE violation) rolls the use_count back.
    // A join refused for a full group still burns that link use; conservative
    // (fewer joins than allowed), never over the cap.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE group_invite_links SET use_count = use_count + 1
         WHERE id = ?1 AND (max_uses IS NULL OR use_count < max_uses)`
      ).bind(link.link_id),
      c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role, perms, created_at)
         SELECT ?1, ?2, 'member', '', ?3
         WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ?1) < ?4`
      ).bind(link.group_id, me, now, LIMITS.membersPerGroup)
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1)
      return jsonError(422, 'limit', 'this invite link has no uses left');
    if (Number(results[1]?.meta.changes ?? 0) !== 1)
      return jsonError(422, 'limit', `limit reached: at most ${LIMITS.membersPerGroup} members per group`);
  } catch (e) {
    if (isUniqueConstraintError(e)) return jsonError(409, 'already_member', 'you are already a member of this group');
    throw e;
  }
  await emitToGroup(c.env, link.group_id,
    { type: 'group.member_joined', actor: c.get('deviceId'), data: { group_id: link.group_id, user_id: me } },
    [me], c.executionCtx);
  const group = await c.env.DB.prepare('SELECT id, name, color, owner_id, created_at, updated_at FROM groups WHERE id = ?1')
    .bind(link.group_id).first();
  return c.json({ group }, 201);
});

// ---------- group projects (feature 6) ----------

groupRoutes.post('/groups/:id/projects', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsedId.data, c.get('user').id, 'manage_projects');
  const parsed = groupCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid project payload', parsed.error.flatten());

  const now = Date.now();
  const id = ulid(now);
  const color = parsed.data.color ?? '#4f8cff';
  try {
    await c.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, color, archived, position, visibility, group_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, 0, 'private', ?5, ?6, ?6)`
    ).bind(id, c.get('user').id, parsed.data.name, color, ctx.group.id, now).run();
  } catch (e: any) {
    if (isUniqueConstraintError(e))
      return jsonError(422, 'duplicate', 'a project with this name already exists');
    throw e;
  }
  const project = await c.env.DB.prepare(
    'SELECT id, user_id, name, color, archived, position, visibility, group_id, created_at, updated_at FROM projects WHERE id = ?1'
  ).bind(id).first();
  // the whole group learns about the new shared project
  const members = await c.env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?1')
    .bind(ctx.group.id).all<{ user_id: string }>();
  await emitToUsers(c.env, members.results.map((m) => ({
    userId: m.user_id,
    draft: { type: 'project.created' as const, actor: c.get('deviceId'), data: { project } }
  })), c.executionCtx);
  return c.json({ project }, 201);
});

// ---------- group report (aggregate buckets — never raw rows) ----------

groupRoutes.get('/groups/:id/report', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroup(c.env, parsedId.data, c.get('user').id);
  const now = Date.now();
  const tz = c.get('user').timezone;
  const today = civilDate(now, tz);
  const qFrom = c.req.query('from');
  const qTo = c.req.query('to');
  const from = qFrom && /^\d{4}-\d{2}-\d{2}$/.test(qFrom) ? qFrom : today;
  const to = qTo && /^\d{4}-\d{2}-\d{2}$/.test(qTo) ? qTo : today;
  const bounds = dayBounds(from, to, tz);
  if (bounds.length === 0) return c.json({ days: [], members: [], server_now: now });
  if (bounds.length > REPORT_MAX_RANGE_DAYS)
    return jsonError(422, 'range_too_large', `report range is limited to ${REPORT_MAX_RANGE_DAYS} days`);
  const rangeStart = bounds[0]!.start;
  const rangeEnd = bounds[bounds.length - 1]!.end;
  const daysJson = JSON.stringify(bounds.map((b) => [b.day, b.start, b.end]));

  // day × project buckets across ALL members' sessions on the group's projects,
  // running sessions clipped to now (same posture as the personal report)
  const [bucketRows, memberRows] = await Promise.all([
    c.env.DB.prepare(
      `WITH days(day, start_ms, end_ms) AS (
         SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'), json_extract(je.value, '$[2]')
         FROM json_each(?1) AS je
       )
       SELECT d.day AS day, t.project_id AS project_id,
              SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), d.end_ms) - MAX(s.started_at, d.start_ms))) AS ms
       FROM time_sessions s
       JOIN tasks t ON t.id = s.task_id
       JOIN days d ON s.started_at < d.end_ms AND COALESCE(s.ended_at, ?2) > d.start_ms
       WHERE t.project_id IN (SELECT id FROM projects WHERE group_id = ?3)
         AND s.started_at < ?4 AND COALESCE(s.ended_at, ?2) > ?5
       GROUP BY d.day, t.project_id`
    ).bind(daysJson, now, ctx.group.id, rangeEnd, rangeStart).all<{ day: string; project_id: string; ms: number }>(),
    c.env.DB.prepare(
      `SELECT s.user_id AS user_id, u.username AS username, u.name AS name, t.project_id AS project_id,
              SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS ms
       FROM time_sessions s
       JOIN tasks t ON t.id = s.task_id
       JOIN users u ON u.id = s.user_id
       WHERE t.project_id IN (SELECT id FROM projects WHERE group_id = ?4)
         AND s.started_at < ?2 AND COALESCE(s.ended_at, ?1) > ?3
       GROUP BY s.user_id, t.project_id`
    ).bind(now, rangeEnd, rangeStart, ctx.group.id).all()
  ]);

  return c.json({
    from, to, timezone: tz,
    days: bucketRows.results.map((r) => ({ day: r.day, project_id: r.project_id, minutes: minutes(Number(r.ms)) })),
    members: memberRows.results.map((r: any) => ({
      user_id: r.user_id, username: r.username, name: r.name,
      project_id: r.project_id, minutes: minutes(Number(r.ms))
    })),
    server_now: now
  });
});

// ---------- invites (username-addressed) ----------

groupRoutes.post('/groups/invites/:inviteId/accept', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('inviteId'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const invite = await c.env.DB.prepare(
    `SELECT i.id, i.group_id FROM group_invites i WHERE i.id = ?1 AND i.invitee_id = ?2 AND i.status = 'pending'`
  ).bind(parsed.data, me).first<{ id: string; group_id: string }>();
  if (!invite) return jsonError(404, 'not_found', 'invite not found');

  const now = Date.now();
  try {
    // member cap enforced inside the INSERT (audit 🟡2); the invite is deleted
    // only once the membership row exists, so a full group leaves the invite
    // pending and retryable
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role, perms, created_at)
         SELECT ?1, ?2, 'member', '', ?3
         WHERE (SELECT COUNT(*) FROM group_members WHERE group_id = ?1) < ?4`
      ).bind(invite.group_id, me, now, LIMITS.membersPerGroup),
      c.env.DB.prepare(
        `DELETE FROM group_invites WHERE id = ?1 AND invitee_id = ?2 AND status = 'pending'
           AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ?3 AND user_id = ?2)`
      ).bind(invite.id, me, invite.group_id)
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1)
      return jsonError(422, 'limit', `limit reached: at most ${LIMITS.membersPerGroup} members per group`);
  } catch (e) {
    if (isUniqueConstraintError(e)) return jsonError(409, 'already_member', 'you are already a member of this group');
    throw e;
  }
  await emitToGroup(c.env, invite.group_id,
    { type: 'group.member_joined', actor: c.get('deviceId'), data: { group_id: invite.group_id, user_id: me } },
    [me], c.executionCtx);
  const group = await c.env.DB.prepare('SELECT id, name, color, owner_id, created_at, updated_at FROM groups WHERE id = ?1')
    .bind(invite.group_id).first();
  return c.json({ group });
});

groupRoutes.post('/groups/invites/:inviteId/decline', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('inviteId'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const res = await c.env.DB.prepare(
    "DELETE FROM group_invites WHERE id = ?1 AND invitee_id = ?2 AND status = 'pending'"
  ).bind(parsed.data, me).run();
  if ((res.meta.changes ?? 0) !== 1) return jsonError(404, 'not_found', 'invite not found');
  return c.json({ ok: true });
});

// ---------- group detail + settings ----------

groupRoutes.get('/groups/:id', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroup(c.env, parsed.data, c.get('user').id);
  const members = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.name, m.role, m.perms, m.created_at AS joined_at
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ?1 AND u.active = 1 ORDER BY m.created_at`
  ).bind(ctx.group.id).all();
  return c.json({
    group: ctx.group, members: members.results,
    my_role: ctx.role, my_perms: [...ctx.perms]
  });
});

groupRoutes.patch('/groups/:id', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsedId.data, c.get('user').id, 'edit_group');
  const parsed = groupPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid group payload', parsed.error.flatten());

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (parsed.data.name !== undefined) { sets.push('name = ?'); binds.push(parsed.data.name); }
  if (parsed.data.color !== undefined) { sets.push('color = ?'); binds.push(parsed.data.color); }
  if (sets.length === 0) return c.json({ group: ctx.group });
  sets.push('updated_at = ?');
  // bind order matches: …, updated_at = ? WHERE id = ? (owner-scoped via context)
  binds.push(Date.now(), ctx.group.id);
  await c.env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  const group = await c.env.DB.prepare('SELECT id, name, color, owner_id, created_at, updated_at FROM groups WHERE id = ?1')
    .bind(ctx.group.id).first();
  await emitToGroup(c.env, ctx.group.id, { type: 'group.updated', actor: c.get('deviceId'), data: { group_id: ctx.group.id } });
  return c.json({ group });
});

groupRoutes.delete('/groups/:id', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroup(c.env, parsed.data, c.get('user').id);
  if (ctx.role !== 'owner') return jsonError(403, 'forbidden', 'only the group owner can delete the group');
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ?1').bind(ctx.group.id).run(); // cascades members/invites/links
  await emitToGroup(c.env, ctx.group.id, { type: 'group.deleted', actor: c.get('deviceId'), data: { group_id: ctx.group.id } });
  return c.json({ ok: true });
});

// ---------- membership changes ----------

groupRoutes.post('/groups/:id/leave', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const ctx = await requireGroup(c.env, parsed.data, me);
  if (ctx.role === 'owner')
    return jsonError(422, 'owner_cannot_leave', 'the owner cannot leave — delete the group instead');
  await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2')
    .bind(ctx.group.id, me).run();
  await emitToGroup(c.env, ctx.group.id,
    { type: 'group.member_left', actor: c.get('deviceId'), data: { group_id: ctx.group.id, user_id: me } }, [me]);
  return c.json({ ok: true });
});

groupRoutes.delete('/groups/:id/members/:userId', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  const targetId = c.req.param('userId');
  if (!parsed.success || !ulidish.safeParse(targetId).success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const ctx = await requireGroupPerm(c.env, parsed.data, me, 'remove_members');
  if (targetId === me) return jsonError(422, 'self', 'use leave to remove yourself');
  if (targetId === ctx.group.owner_id) return jsonError(422, 'owner', 'the owner cannot be removed');
  const res = await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2')
    .bind(ctx.group.id, targetId).run();
  if ((res.meta.changes ?? 0) !== 1) return jsonError(404, 'not_found', 'member not found');
  await emitToGroup(c.env, ctx.group.id,
    { type: 'group.member_removed', actor: c.get('deviceId'), data: { group_id: ctx.group.id, user_id: targetId } },
    [targetId]);
  return c.json({ ok: true });
});

/** Role/permission changes — OWNER only (feature 5: fine-grained admins). */
groupRoutes.patch('/groups/:id/members/:userId', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  const targetId = c.req.param('userId');
  if (!parsed.success || !ulidish.safeParse(targetId).success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const ctx = await requireGroup(c.env, parsed.data, me);
  if (ctx.role !== 'owner') return jsonError(403, 'forbidden', 'only the group owner can manage roles');
  if (targetId === me) return jsonError(422, 'self', "the owner's role is fixed");
  const parsedBody = groupMemberPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsedBody.success) return jsonError(422, 'validation', 'invalid member payload', parsedBody.error.flatten());

  const member = await c.env.DB.prepare(
    'SELECT user_id, role FROM group_members WHERE group_id = ?1 AND user_id = ?2'
  ).bind(ctx.group.id, targetId).first<{ user_id: string; role: 'owner' | 'admin' | 'member' }>();
  if (!member) return jsonError(404, 'not_found', 'member not found');
  if (member.role === 'owner') return jsonError(422, 'owner', "the owner's role is fixed");

  const role = parsedBody.data.role ?? (member.role === 'admin' ? 'admin' : 'member');
  const perms = parsedBody.data.perms !== undefined ? JSON.stringify([...new Set(parsedBody.data.perms)]) : undefined;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (parsedBody.data.role !== undefined) { sets.push('role = ?'); binds.push(role); }
  if (perms !== undefined) { sets.push('perms = ?'); binds.push(perms); }
  if (sets.length === 0) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE group_members SET ${sets.join(', ')} WHERE group_id = ? AND user_id = ?`)
    .bind(...binds, ctx.group.id, targetId).run();
  await emitToGroup(c.env, ctx.group.id,
    { type: 'group.member_updated', actor: c.get('deviceId'), data: { group_id: ctx.group.id, user_id: targetId } });
  return c.json({ ok: true });
});

// ---------- invite management ----------

groupRoutes.post('/groups/:id/invites', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsedId.data, c.get('user').id, 'invite_members');
  const parsed = groupInviteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid username', parsed.error.flatten());

  const target = await c.env.DB.prepare('SELECT id, username, name FROM users WHERE username = ?1 AND active = 1')
    .bind(parsed.data.username).first<{ id: string; username: string; name: string }>();
  if (!target) return jsonError(404, 'not_found', 'no such user');
  const [membership, pending] = await Promise.all([
    c.env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ?1 AND user_id = ?2')
      .bind(ctx.group.id, target.id).first(),
    c.env.DB.prepare("SELECT 1 FROM group_invites WHERE group_id = ?1 AND invitee_id = ?2 AND status = 'pending'")
      .bind(ctx.group.id, target.id).first()
  ]);
  if (membership) return jsonError(409, 'already_member', 'this user is already a member');
  if (pending) return jsonError(409, 'already_invited', 'an invite is already pending for this user');

  const now = Date.now();
  const id = ulid(now);
  await c.env.DB.prepare(
    "INSERT INTO group_invites (id, group_id, invitee_id, invited_by, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)"
  ).bind(id, ctx.group.id, target.id, c.get('user').id, now).run();
  await emitToGroup(c.env, ctx.group.id,
    { type: 'group.invite_created', actor: c.get('deviceId'), data: { group_id: ctx.group.id, invite_id: id, invitee_id: target.id } },
    [target.id], c.executionCtx);
  return c.json({ invite: { id, user: target } }, 201);
});

groupRoutes.get('/groups/:id/invites', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsed.data, c.get('user').id, 'invite_members');
  const invites = await c.env.DB.prepare(
    `SELECT i.id AS invite_id, i.created_at, u.id AS user_id, u.username, u.name
     FROM group_invites i JOIN users u ON u.id = i.invitee_id
     WHERE i.group_id = ?1 AND i.status = 'pending' AND u.active = 1 ORDER BY i.created_at`
  ).bind(ctx.group.id).all();
  return c.json({ invites: invites.results });
});

/** Cancel a pending invite (anyone holding invite_members). */
groupRoutes.delete('/groups/invites/:inviteId', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('inviteId'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  // authorize via the invite's group before touching the row
  const inv = await c.env.DB.prepare('SELECT group_id FROM group_invites WHERE id = ?1')
    .bind(parsed.data).first<{ group_id: string }>();
  if (!inv) return jsonError(404, 'not_found', 'invite not found');
  await requireGroupPerm(c.env, inv.group_id, c.get('user').id, 'invite_members');
  const res = await c.env.DB.prepare("DELETE FROM group_invites WHERE id = ?1 AND status = 'pending'")
    .bind(parsed.data).run();
  if ((res.meta.changes ?? 0) !== 1) return jsonError(404, 'not_found', 'invite not found');
  await emitToGroup(c.env, inv.group_id,
    { type: 'group.invite_removed', actor: c.get('deviceId'), data: { group_id: inv.group_id, invite_id: parsed.data } });
  return c.json({ ok: true });
});

// ---------- invite links (token capability) ----------

groupRoutes.post('/groups/:id/links', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsedId.data, c.get('user').id, 'invite_members');
  const parsed = groupLinkCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid link payload', parsed.error.flatten());

  const token = randomToken(32);                       // returned ONCE, never stored raw
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const id = ulid(now);
  const expiresAt = parsed.data.expires_in_days == null ? null : now + parsed.data.expires_in_days * 24 * 3600_000;
  // active-link cap enforced inside the INSERT (audit 🟡2)
  const ins = await c.env.DB.prepare(
    `INSERT INTO group_invite_links (id, group_id, token_hash, created_by, expires_at, max_uses, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE (SELECT COUNT(*) FROM group_invite_links WHERE group_id = ?2 AND revoked_at IS NULL) < ?8`
  ).bind(id, ctx.group.id, tokenHash, c.get('user').id, expiresAt, parsed.data.max_uses ?? null, now,
    LIMITS.inviteLinksPerGroup).run();
  if (Number(ins.meta.changes ?? 0) !== 1)
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.inviteLinksPerGroup} active invite links`);
  return c.json({
    link: { id, expires_at: expiresAt, max_uses: parsed.data.max_uses ?? null },
    token,                       // the only time the raw token is ever returned
    join_path: `/join/${token}`
  }, 201);
});

groupRoutes.get('/groups/:id/links', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsed.data, c.get('user').id, 'invite_members');
  const links = await c.env.DB.prepare(
    `SELECT id, created_by, expires_at, max_uses, use_count, revoked_at, created_at
     FROM group_invite_links WHERE group_id = ?1 ORDER BY created_at DESC`
  ).bind(ctx.group.id).all();
  return c.json({ links: links.results });
});

groupRoutes.delete('/groups/:id/links/:linkId', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const ctx = await requireGroupPerm(c.env, parsedId.data, c.get('user').id, 'invite_members');
  const parsedLink = ulidish.safeParse(c.req.param('linkId'));
  if (!parsedLink.success) return jsonError(422, 'validation', 'invalid id');
  const res = await c.env.DB.prepare(
    'UPDATE group_invite_links SET revoked_at = ?1 WHERE id = ?2 AND group_id = ?3 AND revoked_at IS NULL'
  ).bind(Date.now(), parsedLink.data, ctx.group.id).run();
  if ((res.meta.changes ?? 0) !== 1) return jsonError(404, 'not_found', 'link not found');
  return c.json({ ok: true });
});

// ---------- join-page preview (token = capability, read-only) ----------

groupRoutes.get('/groups/join/preview', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const token = c.req.query('token') ?? '';
  if (token.length < 16) return jsonError(422, 'validation', 'invalid token');
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.color,
            (SELECT COUNT(*) FROM group_members cm JOIN users cu ON cu.id = cm.user_id
             WHERE cm.group_id = g.id AND cu.active = 1) AS member_count
     FROM group_invite_links l JOIN groups g ON g.id = l.group_id
     WHERE l.token_hash = ?1 AND l.revoked_at IS NULL
       AND (l.expires_at IS NULL OR l.expires_at > ?2)
       AND (l.max_uses IS NULL OR l.use_count < l.max_uses)`
  ).bind(tokenHash, Date.now()).first();
  if (!row) return jsonError(404, 'not_found', 'this invite link is invalid, expired or revoked');
  return c.json({ group: row });
});
