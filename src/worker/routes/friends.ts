// Social layer, phase 1: friend requests by username + friends-visible projects.
// Cross-user events append one sync_log row per recipient (emitToUsers) and fan
// out via each recipient's UserHub; state changes are signaled — clients refetch
// the (small) social lists rather than reconciling entity payloads.
// Privacy posture: username lookups return {id, username, name} only; project
// reads below expose structure + aggregate buckets + live presence — never raw
// session rows, never session notes (NFR-1 parity with the reports surface).
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy, rateLimitHit, rateRules } from '../middleware';
import { friendRequestSchema, ulidish, USERNAME_RE } from '../validators';
import { emitToUsers } from '../events';
import { ulid } from '../../shared/ids';
import { RuleError, isUniqueConstraintError } from '../rules';
import { friendVisiblePresence } from '../social';
import { dayBounds, civilDate, minutes } from '../../shared/time';
import { LIMITS, REPORT_MAX_RANGE_DAYS } from '../../shared/constants';

export const friendRoutes = new Hono<WorkerType>();
friendRoutes.use('/friends', requireAuth);
friendRoutes.use('/friends/*', requireAuth);
friendRoutes.use('/users/lookup', requireAuth);

interface UserSummary { id: string; username: string; name: string }

async function getFriendSummary(env: Env, userId: string): Promise<UserSummary | null> {
  return await env.DB.prepare('SELECT id, username, name FROM users WHERE id = ?1 AND active = 1')
    .bind(userId).first<UserSummary>();
}

/** 404 unless `other` is an active friend of `me`. */
async function requireFriendship(env: Env, me: string, other: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2')
    .bind(me, other).first();
  if (!row) throw new RuleError(404, 'not_found', 'friend not found');
}

// ---------- list ----------

/** Friends + pending requests, shared by GET /friends and GET /bootstrap. */
export async function socialLists(db: D1Database, userId: string) {
  const [friends, incoming, outgoing] = await Promise.all([
    db.prepare(
      `SELECT u.id, u.username, u.name, f.created_at AS since
       FROM friendships f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?1 AND u.active = 1 ORDER BY u.username`
    ).bind(userId).all(),
    db.prepare(
      `SELECT r.id AS request_id, r.created_at, u.id AS user_id, u.username, u.name
       FROM friend_requests r JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = ?1 AND u.active = 1 ORDER BY r.created_at`
    ).bind(userId).all(),
    db.prepare(
      `SELECT r.id AS request_id, r.created_at, u.id AS user_id, u.username, u.name
       FROM friend_requests r JOIN users u ON u.id = r.to_user_id
       WHERE r.from_user_id = ?1 AND u.active = 1 ORDER BY r.created_at`
    ).bind(userId).all()
  ]);
  return { friends: friends.results, incoming: incoming.results, outgoing: outgoing.results };
}

friendRoutes.get('/friends', async (c) => {
  return c.json(await socialLists(c.env.DB, c.get('user').id));
});

// ---------- username resolution ----------

const lookupSchema = z.object({ username: z.string().trim().toLowerCase().regex(USERNAME_RE) });

friendRoutes.get('/users/lookup', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsed = lookupSchema.safeParse({ username: c.req.query('username') ?? '' });
  if (!parsed.success) return jsonError(422, 'validation', 'invalid username');
  const user = await c.env.DB.prepare('SELECT id, username, name FROM users WHERE username = ?1 AND active = 1')
    .bind(parsed.data.username).first<UserSummary>();
  // one message for "no such user" and "deactivated user" — no existence oracle
  if (!user) return jsonError(404, 'not_found', 'no such user');
  return c.json({ user });
});

// ---------- requests ----------

friendRoutes.post('/friends/requests', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsed = friendRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid username', parsed.error.flatten());
  const me = c.get('user').id;
  const actor = c.get('deviceId');

  const target = await c.env.DB.prepare('SELECT id, username, name, active FROM users WHERE username = ?1')
    .bind(parsed.data.username).first<UserSummary & { active: 0 | 1 }>();
  if (!target || !target.active) return jsonError(404, 'not_found', 'no such user');
  if (target.id === me) return jsonError(422, 'self', "you can't befriend yourself");

  const [already, reverse] = await Promise.all([
    c.env.DB.prepare('SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(me, target.id).first(),
    c.env.DB.prepare('SELECT id FROM friend_requests WHERE from_user_id = ?1 AND to_user_id = ?2')
      .bind(target.id, me).first<{ id: string }>()
  ]);
  if (already) return jsonError(409, 'already_friends', 'you are already friends');
  if (reverse) {
    // they asked first — accepting is the only sensible reply
    const friend = await acceptById(c.env, reverse.id, me, target.id, actor);
    return c.json({ accepted: true, request: null, friend }, 201);
  }
  const dup = await c.env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_user_id = ?1 AND to_user_id = ?2')
    .bind(me, target.id).first();
  if (dup) return jsonError(409, 'already_requested', 'a friend request is already pending');

  const [friendCount, outCount] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?1').bind(me).first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_user_id = ?1').bind(me).first<{ n: number }>()
  ]);
  if (Number(friendCount?.n ?? 0) >= LIMITS.friendsMax)
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.friendsMax} friends`);
  if (Number(outCount?.n ?? 0) >= LIMITS.pendingRequestsMax)
    return jsonError(422, 'limit', `limit reached: at most ${LIMITS.pendingRequestsMax} pending sent requests`);

  const now = Date.now();
  const id = ulid(now);
  await c.env.DB.prepare(
    'INSERT INTO friend_requests (id, from_user_id, to_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)'
  ).bind(id, me, target.id, now).run();

  const meSummary = { id: me, username: c.get('user').username, name: c.get('user').name };
  const themSummary = { id: target.id, username: target.username, name: target.name };
  await emitToUsers(c.env, [
    { userId: target.id, draft: { type: 'friend.requested', actor, data: { user: meSummary } } },
    { userId: me, draft: { type: 'friend.requested', actor, data: { user: themSummary } } }
  ], c.executionCtx);
  return c.json({ request: { id, user: themSummary } }, 201);
});

/** Shared accept path (explicit accept + auto-accept of a reverse request).
 *  One batch: delete the request + insert both friendship rows (transactional —
 *  a UNIQUE violation means already friends and the whole batch rolls back). */
async function acceptById(env: Env, requestId: string, me: string, fromUser: string, actor: string): Promise<UserSummary> {
  const now = Date.now();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?1').bind(me).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= LIMITS.friendsMax)
    throw new RuleError(422, 'limit', `limit reached: at most ${LIMITS.friendsMax} friends`);
  try {
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM friend_requests WHERE id = ?1 AND to_user_id = ?2').bind(requestId, me),
      env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)').bind(me, fromUser, now),
      env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)').bind(fromUser, me, now)
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new RuleError(404, 'not_found', 'request not found');
  } catch (e) {
    if (isUniqueConstraintError(e)) throw new RuleError(409, 'already_friends', 'you are already friends');
    throw e;
  }
  const them = await getFriendSummary(env, fromUser);
  if (!them) throw new RuleError(404, 'not_found', 'friend not found');
  const meSummary = await getFriendSummary(env, me);
  await emitToUsers(env, [
    { userId: me, draft: { type: 'friend.accepted', actor, data: { user: them } } },
    { userId: fromUser, draft: { type: 'friend.accepted', actor, data: { user: meSummary } } }
  ]);
  return them;
}

friendRoutes.post('/friends/requests/:id/accept', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const row = await c.env.DB.prepare('SELECT id, from_user_id FROM friend_requests WHERE id = ?1 AND to_user_id = ?2')
    .bind(parsed.data, c.get('user').id).first<{ id: string; from_user_id: string }>();
  if (!row) return jsonError(404, 'not_found', 'request not found');
  const friend = await acceptById(c.env, row.id, c.get('user').id, row.from_user_id, c.get('deviceId'));
  return c.json({ accepted: true, friend });
});

/**
 * Decline (as recipient) / cancel (as sender): the request row disappears and
 * both sides get a `friend.removed` signal. The sender receives no rejection
 * notice beyond their outgoing entry vanishing.
 */
async function removeRequest(env: Env, requestId: string, me: string, side: 'to_user_id' | 'from_user_id', actor: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ?1 AND ${side} = ?2`
  ).bind(requestId, me).first<{ id: string; from_user_id: string; to_user_id: string }>();
  if (!row) throw new RuleError(404, 'not_found', 'request not found');
  await env.DB.prepare('DELETE FROM friend_requests WHERE id = ?1').bind(row.id).run();
  const otherId = side === 'to_user_id' ? row.from_user_id : row.to_user_id;
  await emitRemoved(env, actor, me, otherId);
}

/** `friend.removed` to both sides, addressed from each side's perspective. */
async function emitRemoved(env: Env, actor: string, a: string, b: string): Promise<void> {
  const [aSummary, bSummary] = await Promise.all([getFriendSummary(env, a), getFriendSummary(env, b)]);
  await emitToUsers(env, [
    ...(aSummary ? [{ userId: a, draft: { type: 'friend.removed' as const, actor, data: { user: bSummary } } }] : []),
    ...(bSummary ? [{ userId: b, draft: { type: 'friend.removed' as const, actor, data: { user: aSummary } } }] : [])
  ]);
}

friendRoutes.post('/friends/requests/:id/decline', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  await removeRequest(c.env, parsed.data, c.get('user').id, 'to_user_id', c.get('deviceId'));
  return c.json({ ok: true });
});

// DELETE = cancel an outgoing request
friendRoutes.delete('/friends/requests/:id', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('id'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  await removeRequest(c.env, parsed.data, c.get('user').id, 'from_user_id', c.get('deviceId'));
  return c.json({ ok: true });
});

// ---------- unfriend ----------

friendRoutes.delete('/friends/:friendId', async (c) => {
  const parsed = ulidish.safeParse(c.req.param('friendId'));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const otherId = parsed.data;
  const results = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(me, otherId),
    c.env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(otherId, me)
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1)
    return jsonError(404, 'not_found', 'friend not found');
  await emitRemoved(c.env, c.get('deviceId'), me, otherId);
  return c.json({ ok: true });
});

// ---------- live presence ----------

/** Current tracking state of the given friends, as far as the caller may see:
 *  a friend running a timer on a friends-visible project, else null. */
friendRoutes.post('/friends/presence', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const parsed = z.object({ ids: z.array(ulidish).max(LIMITS.friendsMax) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid ids');
  const me = c.get('user').id;
  const ids = parsed.data.ids;
  const presence: Record<string, unknown> = {};
  if (ids.length > 0) {
    const checks = await c.env.DB.prepare(
      `SELECT friend_id FROM friendships WHERE user_id = ?1 AND friend_id IN (${ids.map(() => '?').join(',')})`
    ).bind(me, ...ids).all<{ friend_id: string }>();
    const allowed = new Set(checks.results.map((r) => r.friend_id));
    await Promise.all(ids.map(async (id) => {
      presence[id] = allowed.has(id) ? await friendVisiblePresence(c.env, id) : null;
    }));
  }
  return c.json({ presence, server_now: Date.now() });
});

// ---------- friends-visible projects ----------

friendRoutes.get('/friends/:friendId/projects', async (c) => {
  const me = c.get('user').id;
  const friendId = c.req.param('friendId');
  if (!ulidish.safeParse(friendId).success) return jsonError(422, 'validation', 'invalid id');
  await requireFriendship(c.env, me, friendId);
  const friend = await getFriendSummary(c.env, friendId);
  if (!friend) return jsonError(404, 'not_found', 'friend not found');
  const [projects, presence] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, color, archived, position, created_at, updated_at, visibility
       FROM projects
       WHERE user_id = ?1 AND visibility = 'friends' AND group_id IS NULL
       ORDER BY position, created_at`
    ).bind(friendId).all(),
    friendVisiblePresence(c.env, friendId)
  ]);
  return c.json({ friend, projects: projects.results, running: presence, server_now: Date.now() });
});

/** One shared project: structure (tasks + checklists, no notes) + aggregate
 *  day buckets in the VIEWER's timezone. Buckets only — never session rows. */
friendRoutes.get('/friends/:friendId/projects/:projectId', async (c) => {
  const me = c.get('user').id;
  const friendId = c.req.param('friendId');
  const projectId = c.req.param('projectId');
  if (!ulidish.safeParse(friendId).success || !ulidish.safeParse(projectId).success)
    return jsonError(422, 'validation', 'invalid id');
  await requireFriendship(c.env, me, friendId);

  const project = await c.env.DB.prepare(
    `SELECT id, name, color, archived, position, created_at, updated_at, visibility
     FROM projects WHERE id = ?1 AND user_id = ?2 AND visibility = 'friends' AND group_id IS NULL`
  ).bind(projectId, friendId).first();
  if (!project) return jsonError(404, 'not_found', 'project not found');

  const now = Date.now();
  const tz = c.get('user').timezone;
  const today = civilDate(now, tz);
  const qFrom = c.req.query('from');
  const qTo = c.req.query('to');
  const from = qFrom && /^\d{4}-\d{2}-\d{2}$/.test(qFrom) ? qFrom : civilDate(now - 29 * 24 * 3600_000, tz);
  const to = qTo && /^\d{4}-\d{2}-\d{2}$/.test(qTo) ? qTo : today;
  const bounds = dayBounds(from, to, tz);
  if (bounds.length > REPORT_MAX_RANGE_DAYS)
    return jsonError(422, 'range_too_large', `report range is limited to ${REPORT_MAX_RANGE_DAYS} days`);
  const rangeStart = bounds[0]!.start;
  const rangeEnd = bounds[bounds.length - 1]!.end;
  const daysJson = JSON.stringify(bounds.map((b) => [b.day, b.start, b.end]));

  const [tasks, subtasks, bucketRows, presence] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, done, position FROM tasks WHERE project_id = ?1 AND user_id = ?2 ORDER BY position, created_at`
    ).bind(projectId, friendId).all(),
    c.env.DB.prepare(
      `SELECT sb.id, sb.task_id, sb.name, sb.done, sb.position
       FROM subtasks sb JOIN tasks t ON t.id = sb.task_id
       WHERE t.project_id = ?1 AND t.user_id = ?2 ORDER BY sb.position, sb.created_at`
    ).bind(projectId, friendId).all(),
    c.env.DB.prepare(
      `WITH days(day, start_ms, end_ms) AS (
         SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'), json_extract(je.value, '$[2]')
         FROM json_each(?1) AS je
       )
       SELECT d.day AS day,
              SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), d.end_ms) - MAX(s.started_at, d.start_ms))) AS ms
       FROM time_sessions s
       JOIN tasks t ON t.id = s.task_id
       JOIN days d ON s.started_at < d.end_ms AND COALESCE(s.ended_at, ?2) > d.start_ms
       WHERE s.user_id = ?3 AND t.project_id = ?4 AND s.started_at < ?5 AND COALESCE(s.ended_at, ?2) > ?6
       GROUP BY d.day`
    ).bind(daysJson, now, friendId, projectId, rangeEnd, rangeStart).all<{ day: string; ms: number }>(),
    friendVisiblePresence(c.env, friendId)
  ]);

  const days = bucketRows.results.map((r) => ({ day: r.day, minutes: minutes(Number(r.ms)) }));
  return c.json({
    project, tasks: tasks.results, subtasks: subtasks.results, days,
    total_minutes: minutes(bucketRows.results.reduce((a, r) => a + Number(r.ms ?? 0), 0)),
    running: presence && presence.project_id === projectId ? presence : null,
    from, to, timezone: tz, server_now: now
  });
});
