// Event pipeline (spec §5.4): mutations append to sync_log, then the Worker asks
// the user's UserHub DO to fan the event out over its WebSockets (via
// ctx.waitUntil). If the notify fails, clients still converge via
// GET /api/sync?since= (sync_log is the source of truth for catch-up).
//
// Batch granularity: the UserHub DO writes entity rows and events in ONE
// batch; route handlers write the entity in one batch and appendEvents in a
// second, so a crash between them can drop the event (clients recover via
// the reconcile poll).

import type { Env } from './env';
import { WsEvent, EventType } from '../shared/constants';

export interface EventDraft<T = unknown> {
  type: EventType;
  actor: string;
  data: T;
}

/** Append events to sync_log and return full events with ids. */
export async function appendEvents(env: Env, userId: string, drafts: EventDraft[]): Promise<WsEvent[]> {
  if (drafts.length === 0) return [];
  const now = Date.now();
  const stmts = drafts.map((d) =>
    env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      userId,
      d.type,
      JSON.stringify({ actor: d.actor, data: d.data }),
      now,
    ),
  );
  const results = await env.DB.batch(stmts);
  return results.map((r, i) => ({
    id: Number(r.meta.last_row_id),
    type: drafts[i]!.type,
    actor: drafts[i]!.actor,
    at: now,
    data: drafts[i]!.data,
  }));
}

/**
 * Social layer: append ONE event per recipient — each recipient's sync_log gets
 * its own row (and its own AUTOINCREMENT id, consistent with the per-user
 * cursor clients track), then every recipient's UserHub is notified to fan the
 * event out over its WebSockets. One D1 batch for all rows; hub notifies are
 * best-effort via waitUntil. The acting user should be included in `items`
 * when their other devices must learn about the change (the acting device
 * itself applies the API response instead — its own echoes are ignored).
 * Returns the per-recipient event lists (recipient id → events, same order as
 * the given drafts).
 */
export async function emitToUsers(
  env: Env,
  items: Array<{ userId: string; draft: EventDraft }>,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Map<string, WsEvent[]>> {
  const byUser = new Map<string, WsEvent[]>();
  if (items.length === 0) return byUser;
  const now = Date.now();
  const stmts = items.map((it) =>
    env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      it.userId,
      it.draft.type,
      JSON.stringify({ actor: it.draft.actor, data: it.draft.data }),
      now,
    ),
  );
  const results = await env.DB.batch(stmts);
  results.forEach((r, i) => {
    const it = items[i]!;
    const ev: WsEvent = {
      id: Number(r.meta.last_row_id),
      type: it.draft.type,
      actor: it.draft.actor,
      at: now,
      data: it.draft.data,
    };
    const list = byUser.get(it.userId) ?? [];
    list.push(ev);
    byUser.set(it.userId, list);
  });
  for (const [userId, events] of byUser) notifyHub(env, userId, events, ctx);
  return byUser;
}

/**
 * Entity mutations fan out to the acting user's hub — and, when the entity
 * lives in a GROUP project, to every group member's hub (feature 6: shared
 * tasks stay in sync for the whole group). Call AFTER the entity write.
 * `knownGroupId` skips the project lookup when the caller already read the row
 * (the PATCH path reuses the access-resolution read — one less round trip).
 * Returns the acting user's event copies for the API response envelope
 * (their device skips the echo via the actor guard; other devices apply it).
 */
export async function emitEntityEvents(
  env: Env,
  userId: string,
  projectId: string,
  drafts: EventDraft[],
  ctx?: { waitUntil(p: Promise<unknown>): void },
  knownGroupId?: string | null,
): Promise<WsEvent[]> {
  let groupId = knownGroupId;
  if (groupId === undefined) {
    const pr = await env.DB.prepare('SELECT group_id FROM projects WHERE id = ?1')
      .bind(projectId)
      .first<{ group_id: string | null }>();
    groupId = pr?.group_id ?? null;
  }
  if (!groupId) {
    const evs = await appendEvents(env, userId, drafts);
    notifyHub(env, userId, evs, ctx);
    return evs;
  }
  const members = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ?1')
    .bind(groupId)
    .all<{ user_id: string }>();
  const items = members.results.flatMap((m) => drafts.map((d) => ({ userId: m.user_id, draft: d })));
  const byUser = await emitToUsers(env, items, ctx);
  return byUser.get(userId) ?? [];
}

/**
 * Notify the user's UserHub DO to broadcast already-persisted events.
 * When an ExecutionContext is provided the fetch is registered via
 * `waitUntil` so it survives the response; without one it degrades to
 * best-effort fire-and-forget.
 */
export function notifyHub(
  env: Env,
  userId: string,
  events: WsEvent[],
  ctx?: { waitUntil(p: Promise<unknown>): void },
): void {
  if (events.length === 0) return;
  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
  const req = new Request('https://do/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal': '1' },
    body: JSON.stringify({ events }),
  });
  const p = stub.fetch(req).catch(() => {});
  if (ctx) ctx.waitUntil(p);
}

/** Best-effort: close the user's live WebSockets after their sessions were revoked.
 *  - no options  → close every socket (all sessions were revoked);
 *  - `{ keep }`  → close all except the given auth-session id (password change
 *                  / revoke-others: the acting device's session survives);
 *  - `{ only }`  → close just the given auth-session id (single session revoke).
 * Sockets are tagged with their session id at upgrade time (index.ts /api/ws). */
export function revokeHub(env: Env, userId: string, opts?: { keep?: string; only?: string }): void {
  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
  const q = opts?.keep
    ? `?keep=${encodeURIComponent(opts.keep)}`
    : opts?.only
      ? `?only=${encodeURIComponent(opts.only)}`
      : '';
  stub.fetch(new Request(`https://do/revoke${q}`, { method: 'POST', headers: { 'x-internal': '1' } })).catch(() => {});
}
