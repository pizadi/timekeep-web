// Social presence: when a user starts/stops/switches their timer, friends who
// can see the affected project get a `friend.timer` event. The event carries
// only what a friends-visible project already exposes (tracker identity, task
// name, project, started_at) — private projects emit nothing to anyone.
//
// Fan-out shape: one sync_log row per friend (per-user ids, so offline friends
// catch up via the existing /sync reconcile poll) + a best-effort notify of
// each friend's UserHub for live delivery.
import type { Env } from './env';
import { emitToUsers } from './events';

export interface PresenceState {
  task_id: string | null;
  started_at: number | null;
}

/**
 * Announce a timer state change to the user's friends.
 * `running` is the freshly committed running session, or null on stop.
 * Best-effort end to end: any failure leaves friends stale until their next
 * presence fetch — never surfaces as an error to the tracker.
 */
export async function broadcastFriendPresence(
  env: Env,
  userId: string,
  actor: string,
  running: PresenceState | null,
): Promise<void> {
  try {
    // 1. what changed — visibility of the affected project gates everything
    let project: { id: string; name: string } | null = null;
    let task: { id: string; name: string } | null = null;
    if (running && running.task_id && running.started_at) {
      const row = await env.DB.prepare(
        `SELECT p.id, p.name, p.visibility, t.id AS task_id, t.name AS task_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ?1 AND t.user_id = ?2`,
      )
        .bind(running.task_id, userId)
        .first<{ id: string; name: string; visibility: string; task_id: string; task_name: string }>();
      if (!row || row.visibility !== 'friends') return;
      project = { id: row.id, name: row.name };
      task = { id: row.task_id, name: row.task_name };
    }

    // 2. who is watching (active friends only)
    const friends = await env.DB.prepare(
      `SELECT u.id, u.username, u.name FROM friendships f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?1 AND u.active = 1`,
    )
      .bind(userId)
      .all<{ id: string; username: string; name: string }>();
    if (friends.results.length === 0) return;

    await emitToUsers(
      env,
      friends.results.map((f) => ({
        userId: f.id,
        draft: {
          type: 'friend.timer' as const,
          actor,
          data: {
            user: f,
            project, // null on stop — client clears the dot
            task,
            running: !!running,
            started_at: running?.started_at ?? null,
          },
        },
      })),
    );
  } catch (e) {
    console.error(
      JSON.stringify({ evt: 'friend_presence_failed', user_id: userId, message: String((e as Error)?.message ?? e) }),
    );
  }
}

/** Live presence for one friend as seen by a viewer — null when not tracking
 *  or when the running task's project is not friends-visible. */
export async function friendVisiblePresence(
  env: Env,
  friendId: string,
): Promise<{ project_id: string; task_id: string; task_name: string; started_at: number } | null> {
  try {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(friendId));
    const res = await stub.fetch(new Request('https://do/state', { headers: { 'x-internal': '1' } }));
    if (!res.ok) return null;
    const state = await res.json<{ session: { task_id: string; started_at: number } | null }>();
    const s = state?.session;
    if (!s?.task_id) return null;
    const row = await env.DB.prepare(
      `SELECT p.id AS project_id, p.visibility, t.id AS task_id, t.name AS task_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?1 AND t.user_id = ?2`,
    )
      .bind(s.task_id, friendId)
      .first<{ project_id: string; visibility: string; task_id: string; task_name: string }>();
    if (!row || row.visibility !== 'friends') return null;
    return { project_id: row.project_id, task_id: row.task_id, task_name: row.task_name, started_at: s.started_at };
  } catch {
    return null; // hub cold/unavailable — absence of presence is the contract
  }
}
