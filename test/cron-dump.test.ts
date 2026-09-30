// F4 (audit): the daily backup must actually run, must cover EVERY persistent
// table, and must never contain credential material.
//
// The bug this pins: `tableScan` paged every non-users table on the
// (user_id, id) tuple, but three dumped tables have no `id` column
// (task_dependencies, layout, settings) — the dump aborted at the fifth table
// with "no such column: id", aborted its multipart upload, and 500'd the cron
// EVERY NIGHT. `test/cron.test.ts` only exercised the query builder as a
// string, so it passed while the real query could never succeed. This suite
// drives the real `runDailyCron` against a real database (workerd's SQLite via
// Miniflare — the same engine D1 wraps) with every migration applied.
//
// Hermetic: workerd runs in-process, no network. Miniflare arrives pinned via
// wrangler's own dependency (wrangler dev itself runs on it), so the version
// is exactly what CI's e2e job already exercises.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { V4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDailyCron, DUMP_TABLES } from '../src/worker/cron';
import { splitSqlStatements } from './support/sql';
import type { Env } from '../src/worker/env';

// Tables deliberately NOT dumped — transient/derivable state, not user data
// (event deltas, rate-limit counters, DO recovery mirrors, single-use tokens).
const TRANSIENT_TABLES = new Set(['sync_log', 'rate_counters', 'active_timers', 'email_tokens', 'auth_sessions']);

// Credential material that must never reach the dump (audit F4 fix #4):
// - users.password_hash — password material
// - users.totp_secret — placeholder for the deferred 2FA work (F18); excluded
//   so a future rollout cannot silently start writing secrets into plaintext
//   dumps. When 2FA ships, revisit the whole dump-encryption story.
// - group_invite_links.token_hash — a join capability; leaking it lets anyone
//   with R2 read access join a group without an invite.
const SECRET_COLUMNS = new Set(['password_hash', 'token_hash', 'totp_secret']);

// Values planted in seeded rows: if any of these strings survives into the
// dump, a secret VALUE leaked (not just a column name).
const PASSWORD_HASH_CANARY = 'SUPER-SECRET-PASSWORD-HASH';
const TOKEN_HASH_CANARY = 'CANARY-TOKEN-HASH';

/** Persistent-table names parsed out of migrations/*.sql — the dump manifest
 *  must cover exactly this set minus TRANSIENT_TABLES. Deriving the expectation
 *  from the migrations themselves means a future migration that adds a table
 *  fails this test until the dump covers it (backup completeness can't rot). */
function persistentTablesFromMigrations(): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join('migrations', f), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE (\w+)/g)) names.add(m[1]!);
  }
  for (const t of TRANSIENT_TABLES) names.delete(t);
  return names;
}

describe('cron daily dump (F4 integration)', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    const v4 = {
      name: 'cron-dump-test',
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'cron-dump-db' },
      r2Buckets: { R2: 'cron-dump-bucket' },
    } as V4MiniflareOptions;
    mf = new Miniflare(convertV4MiniflareOptions(v4));
    db = (await mf.getD1Database('DB')) as unknown as D1Database;

    // apply the real schema, statement by statement (D1's exec can't take the
    // files verbatim — see test/support/sql.ts)
    for (const f of readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      for (const stmt of splitSqlStatements(readFileSync(join('migrations', f), 'utf8'))) {
        await db.prepare(stmt).run();
      }
    }

    // Seed one+ row per persistent table, FK order. Fixed ids readable in
    // failure output; canaries prove secret exclusion below.
    const seed = async (sql: string, ...params: unknown[]) => {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    };
    const now = 1_789_516_800_000;
    // users (admin is seeded by 0002 itself) — u1 carries the password canary
    await seed(
      `INSERT INTO users (id, email, username, password_hash, name, timezone, week_start, theme, role, active, must_change_password, email_verified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'Alice', 'UTC', 1, 'dark', 'user', 1, 0, ?5, ?5, ?5)`,
      'u1-alice',
      'alice@example.com',
      'alice',
      PASSWORD_HASH_CANARY,
      now,
    );
    await seed(
      `INSERT INTO users (id, email, username, password_hash, name, timezone, week_start, theme, role, active, must_change_password, email_verified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 'Bob', 'UTC', 1, 'system', 'user', 1, 0, ?4, ?4, ?4)`,
      'u2-bob',
      'bob@example.com',
      'bob',
      now,
    );
    await seed(
      `INSERT INTO oauth_accounts (provider, provider_uid, user_id) VALUES ('github', 'oauth-uid-1', 'u1-alice')`,
    );
    await seed(
      `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at, visibility)
       VALUES ('p1', 'u1-alice', 'Alpha', '#4f8cff', 0, 0, ?1, ?1, 'friends')`,
      now,
    );
    await seed(
      `INSERT INTO projects (id, user_id, name, color, archived, position, created_at, updated_at, visibility)
       VALUES ('p2', 'u2-bob', 'Beta', '#4f8cff', 0, 0, ?1, ?1, 'private')`,
      now,
    );
    await seed(
      `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
       VALUES ('t1', 'u1-alice', 'p1', NULL, 'Root A', '', 0, 0, ?1, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
       VALUES ('t2', 'u1-alice', 'p1', NULL, 'Root B', '', 0, 1, ?1, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO tasks (id, user_id, project_id, parent_id, name, notes, done, position, created_at, updated_at)
       VALUES ('t3', 'u2-bob', 'p2', NULL, 'Bob task', '', 0, 0, ?1, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO subtasks (id, task_id, user_id, name, done, position, created_at)
       VALUES ('s1', 't1', 'u1-alice', 'Sub A', 0, 0, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO task_dependencies (task_id, depends_on_id, user_id, created_at) VALUES ('t1', 't2', 'u1-alice', ?1)`,
      now,
    );
    // 5500 sessions: crosses the 5000-row dump page boundary, so the rowid
    // cursor is exercised across MULTIPLE pages of the largest table
    await seed(
      `WITH RECURSIVE seq(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM seq WHERE v < 5500)
       INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
       SELECT 'sess' || printf('%06d', v), 'u1-alice', 't1', v * 1000, v * 1000 + 500, 'manual', '', ?1, ?1 FROM seq`,
      now,
    );
    await seed(
      `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
       VALUES ('sess-bob', 'u2-bob', 't3', ?1, ?2, 'timer', '', ?1, ?1)`,
      now,
      now + 1000,
    );
    await seed(`INSERT INTO settings (user_id, data) VALUES ('u1-alice', '{"theme":"dark"}')`);
    await seed(`INSERT INTO layout (user_id, task_id, x, y) VALUES ('u1-alice', 't1', 1.5, 2.5)`);
    await seed(
      `INSERT INTO goals (id, user_id, name, period, direction, target_minutes, scope, ends_at, created_at, archived_at)
       VALUES ('g1', 'u1-alice', 'daily focus', 'day', 'at_least', 30, '["project:p1"]', NULL, ?1, NULL)`,
      now,
    );
    await seed(
      `INSERT INTO groups (id, name, color, owner_id, created_at, updated_at) VALUES ('grp1', 'Crew', '#4f8cff', 'u1-alice', ?1, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO group_members (group_id, user_id, role, perms, last_read_at, created_at) VALUES ('grp1', 'u1-alice', 'owner', '', 0, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO group_members (group_id, user_id, role, perms, last_read_at, created_at) VALUES ('grp1', 'u2-bob', 'member', '', 0, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO group_invites (id, group_id, invitee_id, invited_by, status, created_at, updated_at)
       VALUES ('inv1', 'grp1', 'u2-bob', 'u1-alice', 'pending', ?1, ?1)`,
      now,
    );
    await seed(
      `INSERT INTO group_invite_links (id, group_id, token_hash, created_by, expires_at, max_uses, use_count, revoked_at, created_at)
       VALUES ('link1', 'grp1', ?1, 'u1-alice', NULL, NULL, 0, NULL, ?2)`,
      TOKEN_HASH_CANARY,
      now,
    );
    await seed(
      `INSERT INTO friend_requests (id, from_user_id, to_user_id, created_at, updated_at) VALUES ('fr1', 'u1-alice', 'u2-bob', ?1, ?1)`,
      now,
    );
    await seed(`INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u1-alice', 'u2-bob', ?1)`, now);
    await seed(`INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u2-bob', 'u1-alice', ?1)`, now);
    await seed(
      `INSERT INTO group_messages (id, group_id, sender_id, body, deleted_at, created_at, updated_at)
       VALUES ('m1', 'grp1', 'u1-alice', 'hello', NULL, ?1, ?1)`,
      now,
    );
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  it('dumps every persistent table, complete, with no credential material', async () => {
    // RED for the F4 bug: this used to throw "no such column: id" at
    // task_dependencies (the fifth table), aborting the nightly dump.
    const env = { DB: db, R2: await mf.getR2Bucket('R2') } as unknown as Env;
    await runDailyCron(env);

    const bucket = await mf.getR2Bucket('R2');
    const listed = await bucket.list({ prefix: 'dumps/' });
    expect(listed.objects.length).toBe(1);
    expect(listed.objects[0]!.key).toMatch(/^dumps\/\d{4}-\d{2}-\d{2}\/dump\.jsonl$/);

    const text = await (await bucket.get(listed.objects[0]!.key))!.text();

    // no secret column NAMES or VALUES anywhere in the dump
    for (const marker of [PASSWORD_HASH_CANARY, TOKEN_HASH_CANARY, 'password_hash', 'token_hash', 'totp_secret']) {
      expect(text).not.toContain(marker);
    }

    const rows = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; row: Record<string, unknown> });
    const byTable = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      if (!byTable.has(r.t)) byTable.set(r.t, []);
      byTable.get(r.t)!.push(r.row);
    }

    const expectedTables = persistentTablesFromMigrations();
    expect(new Set(byTable.keys())).toEqual(expectedTables);
    // cron's own manifest agrees with the spec (guards the manifest drifting
    // while the derived expectation above is the authority)
    expect(new Set(Object.keys(DUMP_TABLES))).toEqual(expectedTables);

    // row counts match the database exactly — a truncated dump fails here
    for (const t of expectedTables) {
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(byTable.get(t), `table ${t}`).toHaveLength(Number(n!.n));
    }
    // the large table really crossed the page boundary (paging is exercised)
    expect(byTable.get('time_sessions')!.length).toBeGreaterThan(5000);

    // dumped columns per table == live schema minus the excluded secrets —
    // pins BOTH directions: no secret included, and no column silently lost
    // from backups when a migration adds one (the manifest must be updated
    // consciously, and CI says so if it wasn't)
    for (const t of expectedTables) {
      const live = (await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map(
        (r) => r.name,
      );
      const expectedCols = live.filter((c) => !SECRET_COLUMNS.has(c)).sort();
      const dumpedCols = new Set<string>();
      for (const row of byTable.get(t)!) for (const k of Object.keys(row)) dumpedCols.add(k);
      expect([...dumpedCols].sort(), `columns of ${t}`).toEqual(expectedCols);
    }
  });
});
