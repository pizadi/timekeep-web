// Event pipeline (spec §5.4): mutations append to sync_log inside the same D1
// batch as the entity write, then the Worker asks the user's UserHub DO to fan
// the event out over its WebSockets. If the notify fails, clients still converge
// via GET /api/sync?since= (sync_log is the source of truth for catch-up).

import type { Env } from './env';
import { WsEvent, EventType } from '../shared/constants';

export interface EventDraft<T = unknown> {
  type: EventType;
  actor: string;
  data: T;
}

/** Append events to sync_log (same transaction as the entity writes) and return full events with ids. */
export async function appendEvents(env: Env, userId: string, drafts: EventDraft[]): Promise<WsEvent[]> {
  if (drafts.length === 0) return [];
  const now = Date.now();
  const stmts = drafts.map((d) =>
    env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, d.type, JSON.stringify({ actor: d.actor, data: d.data }), now)
  );
  const results = await env.DB.batch(stmts);
  return results.map((r, i) => ({
    id: Number(r.meta.last_row_id),
    type: drafts[i]!.type,
    actor: drafts[i]!.actor,
    at: now,
    data: drafts[i]!.data
  }));
}

/** Fire-and-forget notify: the DO broadcasts already-persisted events to connected devices. */
export function notifyHub(env: Env, userId: string, events: WsEvent[]): void {
  if (events.length === 0) return;
  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
  const req = new Request('https://do/notify', {
    method: 'POST',
    body: JSON.stringify({ events })
  });
  // waitUntil at call sites (or plain ignore) — a lost notify only costs a refetch.
  stub.fetch(req).catch(() => {});
}
