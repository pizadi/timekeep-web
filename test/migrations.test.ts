// INV-13: the schema must apply cleanly to every supported legacy data shape.
//
// Migration 0002 is the one that had a real bug, and it is worth understanding
// why it was invisible: it only misbehaves on a database that ALREADY contains
// colliding email local-parts, which no test database ever had — the app has no
// self-signup, so production data was created by admins who could not have
// produced that shape, but a dev/demo database seeded by hand could. The failure
// mode is the worst kind for a migration: it aborts mid-file, leaving the schema
// half-migrated, against real data rather than a fixture.
//
// The statement was:
//
//   UPDATE users SET username = username || '-' || substr(id, 1, 6)
//   WHERE id IN (SELECT id FROM users GROUP BY username HAVING COUNT(*) > 1)
//
// `SELECT id … GROUP BY username` returns ONE arbitrary row per duplicate group,
// so only one row of each group was renamed and the unique index then failed.
// Selecting the DUPLICATE USERNAMES and updating every row that has one fixes
// it — and using the full id rather than a 6-char prefix, because two ids can
// share a prefix.
//
// These run against the real sqlite3 CLI (present locally and on ubuntu-latest)
// so the statements are executed exactly as D1 would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const hasSqlite = (() => {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// AGENTS.md: scratch state lives in .work/, not /tmp.
let dir: string;

const run = (db: string, sql: string) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
const rows = (db: string, sql: string) => run(db, sql).split('\n').filter(Boolean);
const migration = (n: number) => readFileSync(join('migrations', `000${n}_${name(n)}.sql`), 'utf8');

/** migration file name → the middle part, per the numbering scheme */
function name(n: number): string {
  return {
    1: 'init',
    2: 'usernames_admin',
  }[n as 1 | 2]!;
}

/**
 * Run a MULTI-STATEMENT script. The `run` above is deliberately single-statement
 * (`sqlite3 db "<one statement>"` treats a script as one argument, and a
 * trailing `;` with following text is a parse error), so schema files go
 * through stdin instead.
 */
const runScript = (db: string, sql: string) => execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });

beforeAll(() => {
  if (!hasSqlite) return;
  dir = mkdtempSync(join('.work', 'migrations-'));
  mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * A pre-0002 database: 0001's schema, plus the given users.
 *
 * Note the collision shape: 0001 puts `UNIQUE COLLATE NOCASE` on email, so two
 * rows can never share an email — but they CAN share a local part
 * ('a@x.com' and 'a@y.com'), and that is exactly what 0002's dedup exists for.
 * The fixtures use distinct emails with a common local part.
 */
function legacyDb(name: string, users: Array<[string, string]>): string {
  const db = join(dir, `${name}.sqlite`);
  rmSync(db, { force: true });
  const full = readFileSync(join('migrations', '0001_init.sql'), 'utf8');
  // the users table alone: the rest of 0001 references it via FK, which SQLite
  // does not enforce at CREATE time, and these tests never touch child rows
  const base = full.slice(0, full.indexOf('CREATE TABLE oauth_accounts'));
  runScript(db, base);
  for (const [id, email] of users) {
    run(
      db,
      `INSERT INTO users (id, email, password_hash, name, timezone, week_start, theme, email_verified_at, created_at, updated_at)
             VALUES ('${id}', '${email}', NULL, '', 'UTC', 1, 'system', 1, 1, 1);`,
    );
  }
  return db;
}

/** Apply 0002 to `db`, returning the error message on failure ('' on success). */
function apply0002(db: string): string {
  try {
    runScript(db, migration(2));
    return '';
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
}

/**
 * The unique index the migration creates must actually be ENFORCED — proven by
 * attempting a duplicate, not by inspecting sqlite_master (which would only
 * prove the index was created, not that it holds).
 */
function expectUniqueHeld(db: string): void {
  expect(run(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_users_username'")).toBe('1');
  // stderr piped, not inherited: the sqlite3 CLI prints the constraint violation
  // it is SUPPOSED to produce here, and it was showing up in the test output as
  // if something had gone wrong.
  expect(() =>
    execFileSync(
      'sqlite3',
      [db, "INSERT INTO users (id, email, created_at, updated_at) VALUES ('probe', 'probe@x.com', 1, 1);"],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  ).not.toThrow();
  expect(() =>
    execFileSync(
      'sqlite3',
      [db, "UPDATE users SET username = (SELECT username FROM users WHERE id = 'u1') WHERE id = 'probe';"],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  ).toThrow();
}

describe.skipIf(!hasSqlite)('migration 0002 (INV-13)', () => {
  it('applies to a clean database', () => {
    const db = legacyDb('clean', [
      ['u1', 'a@x.com'],
      ['u2', 'b@x.com'],
    ]);
    expect(apply0002(db)).toBe('');
    // the seeded admin is part of the result (0002 inserts it)
    expect(rows(db, "SELECT username FROM users WHERE id != '01M2KR6R00895PBREEM1ET1JHT' ORDER BY id")).toEqual([
      'a',
      'b',
    ]);
    expect(rows(db, "SELECT COUNT(*) FROM users WHERE username = 'admin'")).toEqual(['1']);
    // no NULL usernames, and the unique index exists and holds
    expect(run(db, 'SELECT COUNT(*) FROM users WHERE username IS NULL')).toBe('0');
    expectUniqueHeld(db);
  });

  it('de-duplicates a colliding local-part pair', () => {
    const db = legacyDb('pair', [
      ['u1', 'dup@x.com'],
      ['u2', 'dup@y.com'],
    ]);
    expect(apply0002(db)).toBe('');
    const names = rows(db, "SELECT username FROM users WHERE id != '01M2KR6R00895PBREEM1ET1JHT' ORDER BY id");
    expect(new Set(names).size).toBe(2);
    // BOTH rows are renamed — the old statement renamed one and relied on the
    // survivor being unique by luck, which is what broke at 3+
    expect(names.every((n) => n.startsWith('dup-'))).toBe(true);
    expectUniqueHeld(db);
  });

  it('de-duplicates THREE or more rows sharing a local-part', () => {
    const db = legacyDb('triple', [
      ['u1', 'dup@x.com'],
      ['u2', 'dup@y.com'],
      ['u3', 'dup@z.com'],
    ]);
    expect(apply0002(db)).toBe('');
    const names = rows(db, "SELECT username FROM users WHERE id != '01M2KR6R00895PBREEM1ET1JHT' ORDER BY id");
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('de-duplicates SEVERAL independent groups in one database', () => {
    const db = legacyDb('groups', [
      ['u1', 'dup@x.com'],
      ['u2', 'dup@y.com'],
      ['u3', 'other@x.com'],
      ['u4', 'other@y.com'],
      ['u5', 'solo@x.com'],
    ]);
    expect(apply0002(db)).toBe('');
    const names = rows(db, "SELECT username FROM users WHERE id != '01M2KR6R00895PBREEM1ET1JHT' ORDER BY id");
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    // the singleton is untouched
    expect(names).toContain('solo');
  });

  it('survives ids that share a 6-character prefix', () => {
    // the old statement used substr(id, 1, 6) as the disambiguator, so two ids
    // differing only after the prefix produced identical usernames
    const db = legacyDb('prefix', [
      ['abcdef111', 'dup@x.com'],
      ['abcdef222', 'dup@y.com'],
    ]);
    expect(apply0002(db)).toBe('');
    const names = rows(db, "SELECT username FROM users WHERE id != '01M2KR6R00895PBREEM1ET1JHT' ORDER BY id");
    expect(new Set(names).size).toBe(2);
  });

  it('is idempotent-ish: the admin seed does not duplicate on a second run', () => {
    const db = legacyDb('seed', [['u1', 'a@x.com']]);
    expect(apply0002(db)).toBe('');
    const first = run(db, 'SELECT COUNT(*) FROM users');
    // 0002 guards its own insert, so a legacy DB that already had an 'admin'
    // account does not get a second one — re-running the statements is a no-op
    // for the seed
    expect(Number(first)).toBe(2); // the seeded admin + u1
    expect(rows(db, "SELECT COUNT(*) FROM users WHERE username = 'admin'")).toEqual(['1']);
  });

  it('leaves the whole schema consistent (all columns present)', () => {
    const db = legacyDb('columns', [['u1', 'a@x.com']]);
    apply0002(db);
    for (const col of ['username', 'role', 'active', 'must_change_password']) {
      expect(run(db, `SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = '${col}'`)).toBe('1');
    }
  });
});
