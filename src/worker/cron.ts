// Cron Trigger (daily, FR-D3): logical dump → R2 (30-day retention), sync_log
// prune (keeps ≥ 1 h of events per user for reconnect deltas, FR-N3).
// Idempotent + resumable (NFR-2).
import type { Env } from './env';

export async function runDailyCron(env: Env): Promise<void> {
  const now = Date.now();

  // 1. prune sync_log older than 2 hours (delta window is ≥ 1 h, FR-N3)
  await env.DB.prepare('DELETE FROM sync_log WHERE created_at < ?1')
    .bind(now - 2 * 3600_000).run();

  // 2. daily logical dump per table → R2 JSONL (skipped when R2 is not bound)
  if (env.R2) {
    const day = new Date(now).toISOString().slice(0, 10);
    const dump: [string, string][] = [];
    const tables = ['users', 'projects', 'tasks', 'subtasks', 'task_dependencies', 'time_sessions', 'settings', 'layout'];
    for (const t of tables) {
      // paginated read to bound memory
      let lastId = '';
      for (;;) {
        const where = t === 'users' ? 'id > ?1' : 'user_id > ?1';
        const order = t === 'users' ? 'id' : 'user_id, id';
        const res = await env.DB.prepare(
          `SELECT * FROM ${t} WHERE ${where} ORDER BY ${order} LIMIT 5000`
        ).bind(lastId).all().catch(() => null);
        if (!res || res.results.length === 0) break;
        dump.push([t, res.results.map((r) => JSON.stringify(r)).join('\n')]);
        const last: any = res.results[res.results.length - 1];
        lastId = t === 'users' ? last.id : `${last.user_id}\u0000${last.id ?? ''}`;
        if (res.results.length < 5000) break;
      }
    }
    const body = dump.map(([t, lines]) => lines.split('\n').map((l) => JSON.stringify({ t, row: JSON.parse(l) })).join('\n')).join('\n');
    await env.R2.put(`dumps/${day}/dump.jsonl`, body, {
      customMetadata: { generated_at: String(now) }
    });

    // 3. prune dumps older than 30 days (FR-D3 AC)
    const listed = await env.R2.list({ prefix: 'dumps/' });
    const cutoff = now - 30 * 24 * 3600_000;
    for (const obj of listed.objects) {
      const dayStr = obj.key.split('/')[1] ?? '';
      if (new Date(`${dayStr}T00:00:00Z`).getTime() < cutoff) {
        await env.R2.delete(obj.key);
      }
    }
  }

  console.log(JSON.stringify({ evt: 'cron_daily_done', at: now }));
}
