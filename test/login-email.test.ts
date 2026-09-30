// F15 (audit): `users.email` doubles as the login identifier for users without
// a mailbox — their '@'-free username is stored there — so every mail path had
// to re-derive "is this a real address" with `includes('@')`, a check that is
// easy to forget in new code (reset-request could fire mail at the username
// string of a pre-verified user). Migration 0013 adds the nullable
// `users.login_email` column (set iff a real mailbox exists, backfilled from
// legacy rows) and `realEmail()` becomes the one address derivation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { realEmail } from '../src/worker/auth';

describe('realEmail (F15: one authoritative mailbox derivation)', () => {
  it('prefers login_email when present', () => {
    expect(realEmail({ login_email: 'a@b.co', email: 'legacy' })).toBe('a@b.co');
  });

  it('falls back to the legacy email column during transition', () => {
    expect(realEmail({ login_email: null, email: 'a@b.co' })).toBe('a@b.co');
    expect(realEmail({ email: 'a@b.co' })).toBe('a@b.co');
  });

  it('returns null for the username-mirror shape (no @)', () => {
    expect(realEmail({ login_email: null, email: 'dana' })).toBeNull();
    expect(realEmail({ email: 'dana' })).toBeNull();
  });

  it('returns null for an invalid address even with an @', () => {
    expect(realEmail({ login_email: 'not-an-address@' })).toBeNull();
    expect(realEmail({ login_email: '@' })).toBeNull();
  });

  it('returns null for empty/missing columns', () => {
    expect(realEmail({ login_email: null, email: '' })).toBeNull();
    expect(realEmail({})).toBeNull();
  });
});

// The migration itself, against the real sqlite3 CLI the way
// migrations.test.ts does it: apply 0001–0012, insert the two legacy shapes,
// then apply 0013 and assert the backfill drew the line correctly.
describe('migration 0013_login_email (additive + backfill)', () => {
  const hasSqlite = (() => {
    try {
      execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const WORK = '.work';
  let dir: string;

  beforeAll(() => {
    if (!hasSqlite) return;
    dir = join(WORK, 'login-email-mig');
    execFileSync('mkdir', ['-p', dir]);
  });
  afterAll(() => {
    if (!hasSqlite) return;
    rmSync(dir, { recursive: true, force: true });
  });

  const runScript = (db: string, sql: string) => execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
  const rows = (db: string, sql: string) =>
    execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).split('\n').filter(Boolean);

  it('adds the column, backfills real addresses, leaves username mirrors NULL', () => {
    if (!hasSqlite) {
      console.warn('sqlite3 CLI not available — migration test skipped');
      return;
    }
    const db = join(dir, 't.db');
    const files = readdirSync('migrations')
      .filter((f) => /^00\d+_.+\.sql$/.test(f))
      .sort();
    const legacy = files.filter((f) => f < '0013');
    const m13 = files.find((f) => f.startsWith('0013'));
    expect(m13, 'migrations/0013_login_email.sql must exist').toBeTruthy();

    for (const f of legacy) runScript(db, readFileSync(join('migrations', f), 'utf8'));
    // the two legacy shapes: a real mailbox, and the username mirror ('@'-free)
    runScript(
      db,
      `INSERT INTO users (id, email, username, password_hash, name, timezone, week_start, week_start_dow, theme, role, active, must_change_password, email_verified_at, created_at, updated_at)
       VALUES ('u-real', 'dana@example.com', 'dana', NULL, 'Dana', 'UTC', 1, 1, 'system', 'user', 1, 0, 1, 1, 1),
              ('u-mirror', 'kevin', 'kevin', NULL, 'Kevin', 'UTC', 1, 1, 'system', 'user', 1, 0, 1, 1, 1);`,
    );
    runScript(db, readFileSync(join('migrations', m13!), 'utf8'));

    expect(rows(db, `SELECT login_email FROM users WHERE id = 'u-real';`)).toEqual(['dana@example.com']);
    expect(rows(db, `SELECT login_email FROM users WHERE id = 'u-mirror';`)).toEqual([]);
    // the legacy mirror column is untouched (export/API compatibility)
    expect(rows(db, `SELECT email FROM users WHERE id = 'u-mirror';`)).toEqual(['kevin']);
  });
});
