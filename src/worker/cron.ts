// Cron Trigger (daily, FR-D3): logical dump → R2 (30-day retention), sync_log
// prune (keeps 2 h of events per user for reconnect deltas, FR-N3), plus GC
// of expired auth sessions, email tokens and rate-limit counters.
// Idempotent + resumable (NFR-2).
import type { Env } from './env';

const DUMP_TABLES = ['users', 'projects', 'tasks', 'subtasks', 'task_dependencies', 'time_sessions', 'settings', 'layout'];
const PAGE_SIZE = 5000;
// R2 multipart parts must be ≥ 5 MiB except the final one.
const PART_MIN_BYTES = 5 * 1024 * 1024;

/**
 * Keyset predicate for one dump page. `users` pages on its `id` primary key;
 * every user-scoped table pages on the (user_id, id) tuple, so rows of the
 * last user on a page are never skipped (a plain `user_id >` comparison
 * would drop them, truncating any table larger than one page).
 */
export function tableScan(
  table: string, cursor: { userId: string | null; id: string | null }
): { where: string; order: string; binds: (string | null)[] } {
  if (table === 'users') {
    return { where: 'id > ?1', order: 'id', binds: [cursor.id ?? ''] };
  }
  return {
    where: '(user_id > ?1 OR (user_id = ?1 AND id > ?2))',
    order: 'user_id, id',
    binds: [cursor.userId ?? '', cursor.id ?? '']
  };
}

export async function runDailyCron(env: Env): Promise<void> {
  const now = Date.now();

  // 1. prune sync_log older than 2 hours (delta window is ≥ 1 h, FR-N3)
  await env.DB.prepare('DELETE FROM sync_log WHERE created_at < ?1')
    .bind(now - 2 * 3600_000).run();

  // 2. GC: remove expired auth sessions, email tokens and rate-limit counters
  // so these tables don't grow monotonically.
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM rate_counters WHERE expires_at < ?1').bind(now).run();

  // 3. daily logical dump per table → R2 JSONL (skipped when R2 is not bound)
  if (env.R2) {
    await dumpToR2(env, now);
  }

  console.log(JSON.stringify({ evt: 'cron_daily_done', at: now }));
}

/**
 * Stream every table into a single R2 object via multipart upload: memory is
 * bounded by one page (5000 rows) + one part buffer, not by the whole dump.
 * Read failures propagate — a backup must fail loudly and be retried,
 * not silently truncate.
 */
async function dumpToR2(env: Env, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const mpu = await env.R2!.createMultipartUpload(`dumps/${day}/dump.jsonl`, {
    customMetadata: { generated_at: String(now) }
  });

  try {
    let partNumber = 0;
    let buf = '';
    const parts: R2UploadedPart[] = [];
    const maybeUploadPart = async () => {
      if (buf.length < PART_MIN_BYTES) return;
      parts.push(await mpu.uploadPart(++partNumber, buf));
      buf = '';
    };

    for (const t of DUMP_TABLES) {
      const cursor = { userId: null as string | null, id: null as string | null };
      for (;;) {
        const { where, order, binds } = tableScan(t, cursor);
        const res = await env.DB.prepare(`SELECT * FROM ${t} WHERE ${where} ORDER BY ${order} LIMIT ${PAGE_SIZE}`)
          .bind(...binds).all(); // no .catch(() => null): a failed read aborts the dump loudly
        if (res.results.length === 0) break;
        for (const r of res.results) {
          buf += (buf ? '\n' : '') + JSON.stringify({ t, row: r });
        }
        buf += '\n';
        const last: any = res.results[res.results.length - 1];
        if (t === 'users') cursor.id = last.id;
        else { cursor.userId = last.user_id; cursor.id = last.id ?? ''; }
        if (res.results.length < PAGE_SIZE) break;
        await maybeUploadPart();
      }
    }
    if (buf) parts.push(await mpu.uploadPart(++partNumber, buf));
    await mpu.complete(parts);
  } catch (e) {
    await mpu.abort().catch(() => {}); // don't leave orphaned parts behind
    throw e;
  }

  // 4. prune dumps older than 30 days (FR-D3 AC)
  const listed = await env.R2!.list({ prefix: 'dumps/' });
  const cutoff = now - 30 * 24 * 3600_000;
  for (const obj of listed.objects) {
    const dayStr = obj.key.split('/')[1] ?? '';
    if (new Date(`${dayStr}T00:00:00Z`).getTime() < cutoff) {
      await env.R2!.delete(obj.key);
    }
  }
}
