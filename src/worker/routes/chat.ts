// Social layer, phase 3: group chat.
// Messages live in D1 (no DO state); delivery reuses the social fan-out —
// one sync_log row per member + a notify of each member's UserHub, so live
// clients get `group.message_*` events and offline clients catch up via the
// existing /sync reconcile. The sender's acting device applies the API
// response (its own echo is ignored via the actor===deviceId guard).
import { Hono } from 'hono';
import type { Env, WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy, limitWrites, rateLimitHit, rateRules } from '../middleware';
import { messageCreateSchema, messagePatchSchema, readMarkSchema, ulidish } from '../validators';
import { emitToUsers, EventDraft } from '../events';
import { ulid } from '../../shared/ids';
import { requireGroup, requireGroupPerm } from '../group-auth';

export const chatRoutes = new Hono<WorkerType>();
chatRoutes.use('/groups/:id/messages', requireAuth, limitWrites);
chatRoutes.use('/groups/:id/messages/*', requireAuth, limitWrites);
chatRoutes.use('/groups/:id/read', requireAuth, limitWrites);

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

interface MessageRow {
  id: string;
  group_id: string;
  sender_id: string;
  body: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

function presenter(m: MessageRow, sender: { username: string; name: string }) {
  return {
    id: m.id,
    group_id: m.group_id,
    sender: { id: m.sender_id, username: sender.username, name: sender.name },
    body: m.deleted_at ? '' : m.body,
    deleted_at: m.deleted_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

async function senderName(env: Env, senderId: string): Promise<{ username: string; name: string }> {
  const u = await env.DB.prepare('SELECT username, name FROM users WHERE id = ?1')
    .bind(senderId)
    .first<{ username: string; name: string }>();
  return u ?? { username: 'unknown', name: '' };
}

// ---------- history ----------

chatRoutes.get('/groups/:id/messages', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  await requireGroup(c.env, parsedId.data, c.get('user').id); // members only

  const before = c.req.query('before');
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(c.req.query('limit') ?? PAGE_DEFAULT) || PAGE_DEFAULT));
  if (before && !ulidish.safeParse(before).success) return jsonError(422, 'validation', 'invalid cursor');
  const res = await c.env.DB.prepare(
    `SELECT * FROM group_messages WHERE group_id = ?1 ${before ? 'AND id < ?2' : ''}
     ORDER BY id DESC LIMIT ${limit}`,
  )
    .bind(...(before ? [parsedId.data, before] : [parsedId.data]))
    .all<MessageRow>();
  const rows = [...res.results].reverse(); // oldest → newest for rendering
  const senders = new Map<string, { username: string; name: string }>();
  const messages = [];
  for (const m of rows) {
    if (!senders.has(m.sender_id)) senders.set(m.sender_id, await senderName(c.env, m.sender_id));
    messages.push(presenter(m, senders.get(m.sender_id)!));
  }
  return c.json({
    messages,
    has_more: res.results.length === limit, // older pages exist when the page filled
    server_now: Date.now(),
  });
});

// ---------- send ----------

chatRoutes.post('/groups/:id/messages', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  const ctx = await requireGroup(c.env, parsedId.data, me);
  const parsed = messageCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid message', parsed.error.flatten());

  const now = Date.now();
  const id = ulid(now);
  const message: MessageRow = {
    id,
    group_id: ctx.group.id,
    sender_id: me,
    body: parsed.data.body,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  await c.env.DB.prepare(
    `INSERT INTO group_messages (id, group_id, sender_id, body, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(id, ctx.group.id, me, message.body, now)
    .run();

  const presented = presenter(message, { username: c.get('user').username, name: c.get('user').name });
  await emitToGroupMembers(
    c.env,
    ctx.group.id,
    { type: 'group.message_created', actor: c.get('deviceId'), data: { group_id: ctx.group.id, message: presented } },
    c.executionCtx,
  );
  return c.json({ message: presented, events: [] }, 201);
});

/** All current members see group chat events — including the sender's user
 *  bucket (their OTHER devices apply it; the acting device uses the response). */
async function emitToGroupMembers(
  env: Env,
  groupId: string,
  draft: EventDraft,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const members = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?1')
    .bind(groupId)
    .all<{ user_id: string }>();
  await emitToUsers(
    env,
    members.results.map((m) => ({ userId: m.user_id, draft })),
    ctx,
  );
}

// ---------- edit / delete ----------

chatRoutes.patch('/groups/:id/messages/:mid', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  const parsedMid = ulidish.safeParse(c.req.param('mid'));
  if (!parsedId.success || !parsedMid.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  await requireGroup(c.env, parsedId.data, me);
  const parsed = messagePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid message', parsed.error.flatten());

  const row = await c.env.DB.prepare(
    'SELECT * FROM group_messages WHERE id = ?1 AND group_id = ?2 AND deleted_at IS NULL',
  )
    .bind(parsedMid.data, parsedId.data)
    .first<MessageRow>();
  if (!row) return jsonError(404, 'not_found', 'message not found');
  if (row.sender_id !== me) return jsonError(403, 'forbidden', 'only the sender can edit a message');

  const now = Date.now();
  await c.env.DB.prepare('UPDATE group_messages SET body = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(parsed.data.body, now, row.id)
    .run();
  const presented = presenter({ ...row, body: parsed.data.body, updated_at: now }, await senderName(c.env, me));
  await emitToGroupMembers(
    c.env,
    parsedId.data,
    { type: 'group.message_updated', actor: c.get('deviceId'), data: { group_id: parsedId.data, message: presented } },
    c.executionCtx,
  );
  return c.json({ message: presented });
});

chatRoutes.delete('/groups/:id/messages/:mid', async (c) => {
  const parsedId = ulidish.safeParse(c.req.param('id'));
  const parsedMid = ulidish.safeParse(c.req.param('mid'));
  if (!parsedId.success || !parsedMid.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  await requireGroup(c.env, parsedId.data, me);

  const row = await c.env.DB.prepare(
    'SELECT * FROM group_messages WHERE id = ?1 AND group_id = ?2 AND deleted_at IS NULL',
  )
    .bind(parsedMid.data, parsedId.data)
    .first<MessageRow>();
  if (!row) return jsonError(404, 'not_found', 'message not found');
  if (row.sender_id !== me) {
    // moderation: senders delete their own; others need the explicit permission
    await requireGroupPerm(c.env, parsedId.data, me, 'moderate_messages');
  }

  const now = Date.now();
  await c.env.DB.prepare('UPDATE group_messages SET deleted_at = ?1, body = ?2, updated_at = ?1 WHERE id = ?3')
    .bind(now, '', row.id)
    .run();
  await emitToGroupMembers(
    c.env,
    parsedId.data,
    { type: 'group.message_deleted', actor: c.get('deviceId'), data: { group_id: parsedId.data, message_id: row.id } },
    c.executionCtx,
  );
  return c.json({ ok: true });
});

// ---------- read state (unread badge) ----------

chatRoutes.post('/groups/:id/read', async (c) => {
  const limited = await rateLimitHit(c.env, rateRules(c.env).socialUser, c.get('user').id);
  if (limited) return jsonError(429, 'rate_limited', 'too many requests — retry later');
  const parsedId = ulidish.safeParse(c.req.param('id'));
  if (!parsedId.success) return jsonError(422, 'validation', 'invalid id');
  const me = c.get('user').id;
  await requireGroup(c.env, parsedId.data, me);
  const parsed = readMarkSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(422, 'validation', 'invalid payload');

  const at = parsed.data.at ?? Date.now();
  await c.env.DB.prepare(
    'UPDATE group_members SET last_read_at = MAX(last_read_at, ?1) WHERE group_id = ?2 AND user_id = ?3',
  )
    .bind(at, parsedId.data, me)
    .run();
  return c.json({ ok: true });
});
