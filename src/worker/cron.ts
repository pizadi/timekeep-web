// Cron Trigger (daily, FR-D3): logical dump → R2 (30-day retention), sync_log
// prune (keeps 2 h of events per user for reconnect deltas, FR-N3), plus GC
// of expired auth sessions, email tokens and rate-limit counters. Also warns
// when the seeded admin password is still in use (audit #4).
// Idempotent + resumable (NFR-2).
import type { Env } from './env';
import { verifyPassword } from './auth';

/** The password `migrations/0002_usernames_admin.sql` seeds for `admin`. */
const SEEDED_ADMIN_PASSWORD = 'changemeasap';

/**
 * The dump manifest: every persistent table → its exact SELECT column list,
 * in dump order. Coverage is pinned by test/cron-dump.test.ts against the
 * schema the migrations actually define (minus TRANSIENT_TABLES below), so a
 * migration that adds a table or column fails CI until the manifest is
 * consciously updated — a backup can neither lose columns silently nor start
 * carrying new ones unread.
 *
 * Explicit lists instead of `SELECT *` because the dump is a security-
 * sensitive artifact (plaintext JSONL in R2, audit F4): credential material
 * must never land in it —
 * - users.password_hash (password material),
 * - users.totp_secret (2FA placeholder, F18 — excluded so a future rollout
 *   cannot silently start writing secrets into dumps),
 * - group_invite_links.token_hash (a join capability: anyone with R2 read
 *   access must not be able to mint group invitations).
 */
export const DUMP_TABLES: Record<string, string> = {
  users:
    'id, email, username, name, timezone, week_start, week_start_dow, theme, role, active, must_change_password, email_verified_at, created_at, updated_at',
  oauth_accounts: 'provider, provider_uid, user_id',
  projects: 'id, user_id, name, color, archived, position, created_at, updated_at, visibility, deleted_at, group_id',
  tasks: 'id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at, deleted_at',
  subtasks: 'id, task_id, user_id, name, done, position, created_at',
  task_dependencies: 'task_id, depends_on_id, user_id, created_at',
  time_sessions:
    'id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at, subtask_id, task_name',
  settings: 'user_id, data',
  layout: 'user_id, task_id, x, y',
  goals: 'id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at',
  groups: 'id, name, color, owner_id, created_at, updated_at',
  group_members: 'group_id, user_id, role, perms, last_read_at, created_at',
  group_invites: 'id, group_id, invitee_id, invited_by, status, created_at, updated_at',
  group_invite_links: 'id, group_id, created_by, expires_at, max_uses, use_count, revoked_at, created_at',
  friend_requests: 'id, from_user_id, to_user_id, created_at, updated_at',
  friendships: 'user_id, friend_id, created_at',
  group_messages: 'id, group_id, sender_id, body, deleted_at, created_at, updated_at',
};

const PAGE_SIZE = 5000;
// R2 multipart parts must be ≥ 5 MiB except the final one.
const PART_MIN_BYTES = 5 * 1024 * 1024;

/**
 * Keyset predicate for one dump page: uniform rowid paging (audit F4 fix #1).
 * The previous (user_id, id) tuple assumed an `id` column that
 * task_dependencies/layout/settings don't have — the dump could never get
 * past the fifth table. `rowid` exists on every dumped table (none is
 * WITHOUT ROWID) and is assigned in insertion order, so a plain
 * `rowid > cursor` keyset pages every table identically; within a single
 * read-only dump run rows are never inserted or deleted mid-run, so no row
 * can be skipped or repeated across pages.
 */
export function tableScan(cursor: number): { where: string; order: string; binds: number[] } {
  return { where: 'rowid > ?1', order: 'rowid', binds: [cursor] };
}

/**
 * Loud warning if the seeded admin credential is still in place (audit #4).
 *
 * The hash can't be compared to a fixed string — every account gets a random
 * salt — so this is a real `verifyPassword` of the known default, once a day
 * (6 chained 100k rounds). Cheap enough to run unconditionally, and it turns
 * "nobody noticed" into a log line. Not a lockout: the flag is set, the deploy
 * isn't blocked.
 */
export async function warnOnDefaultAdminPassword(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT password_hash FROM users WHERE username = 'admin' AND role = 'admin' LIMIT 1",
  ).first<{ password_hash: string }>();
  if (!row?.password_hash) return false;
  if (!(await verifyPassword(SEEDED_ADMIN_PASSWORD, row.password_hash))) return false;
  console.warn(
    JSON.stringify({
      evt: 'SECURITY_admin_default_password',
      at: Date.now(),
      message:
        'the admin account still uses the seeded default password — rotate it now (Settings → account, or the admin guide)',
    }),
  );
  return true;
}

export async function runDailyCron(env: Env): Promise<void> {
  const now = Date.now();

  // 0. operational signal: is the public default admin password still live?
  await warnOnDefaultAdminPassword(env).catch(() => {
    /* never fail the cron for a check */
  });

  // 1. prune sync_log older than 2 hours (delta window is ≥ 1 h, FR-N3)
  await env.DB.prepare('DELETE FROM sync_log WHERE created_at < ?1')
    .bind(now - 2 * 3600_000)
    .run();

  // 2. GC: remove expired auth sessions, email tokens and rate-limit counters
  // so these tables don't grow monotonically.
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM rate_counters WHERE expires_at < ?1').bind(now).run();

  // 3. daily dump per table → R2 JSONL (30-day retention, FR-D3). R2 stays
  // OPT-IN (binding it in the committed template would break fresh deploys —
  // the bucket id is instance-specific), but the absence is loud: without it
  // this instance has NO automatic backup, only D1 Time Travel.
  if (env.R2) {
    await dumpToR2(env, now);
  } else {
    console.warn(
      JSON.stringify({
        evt: 'SECURITY_backup_not_configured',
        at: now,
        message:
          'no R2 binding — the daily D1 dump is SKIPPED and this instance has no automatic backup. Create an R2 bucket and bind it as `R2` (docs/deployment.md → Backups). D1 Time Travel (30 days) remains available as a safety net.',
      }),
    );
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
    customMetadata: { generated_at: String(now) },
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

    for (const [t, columns] of Object.entries(DUMP_TABLES)) {
      let cursor = 0;
      for (;;) {
        const { where, order, binds } = tableScan(cursor);
        // rowid rides along only to advance the cursor; it is stripped before
        // serialization so it never appears in the dump itself
        const res = await env.DB.prepare(`SELECT ${columns}, rowid FROM ${t} WHERE ${where} ORDER BY ${order} LIMIT ?2`)
          .bind(...binds, PAGE_SIZE)
          .all(); // no .catch(() => null): a failed read aborts the dump loudly
        if (res.results.length === 0) break;
        for (const r of res.results as Record<string, unknown>[]) {
          const { rowid, ...row } = r;
          cursor = Number(rowid);
          buf += (buf ? '\n' : '') + JSON.stringify({ t, row });
        }
        buf += '\n';
        if (res.results.length < PAGE_SIZE) break;
        await maybeUploadPart();
      }
    }
    if (buf) parts.push(await mpu.uploadPart(++partNumber, buf));
    await mpu.complete(parts);
  } catch (e) {
    // a backup must fail LOUDLY (the object is the only automatic backup) —
    // log before rethrowing so the failure is greppable in the worker logs
    console.error(
      JSON.stringify({
        evt: 'cron_dump_failed',
        at: Date.now(),
        message: e instanceof Error ? e.message : String(e),
      }),
    );
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
