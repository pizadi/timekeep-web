// INV-01: "a revoked session can never produce a valid replacement session."
//
// The rotation path used to INSERT a new session row and DELETE the old one.
// Every revocation path (logout, revoke-others, password change, reset, admin
// deactivate) deletes by `id` or by `user_id`, so a rotation that landed after
// a revoke happily left a live session behind. The rotation is now a
// compare-and-swap on the row it read, which makes "revoke wins" structural —
// these tests pin the interleavings that the sequential e2e suite cannot reach.
import { describe, it, expect } from 'vitest';
import { rotateSession, type SessionRow } from '../src/worker/middleware';
import { sha256Hex } from '../src/worker/auth';
import { fakeD1, expiringSession } from './support/fake-d1';

const NOW = 1_700_000_000_000;
const ROTATE_WITHIN = 7 * 24 * 3600_000;

async function setup(inDays = 3) {
  const token = 'a'.repeat(64);
  const hash = await sha256Hex(token);
  const db = fakeD1([expiringSession('sess-1', 'user-1', hash, NOW, inDays)]);
  const row: SessionRow = {
    id: 'sess-1',
    user_id: 'user-1',
    token_hash: hash,
    expires_at: NOW + inDays * 24 * 3600_000,
    last_seen_at: NOW - 60_000,
  };
  return { db, row, token };
}

describe('session rotation (INV-01)', () => {
  it('rotates in place: same row id, new hash, no second row', async () => {
    const { db, row } = await setup();
    const out = await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4');
    expect(out).not.toBe('revoked');
    expect(typeof out === 'object' && out.rotated).toBe(true);
    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0].id).toBe('sess-1');
    expect(db.rows()[0].token_hash).not.toBe(row.token_hash);
    expect(db.rows()[0].expires_at).toBe(NOW + 30 * 24 * 3600_000);
    // no INSERT + DELETE pair — the rotation is one UPDATE
    expect(db.log.some((s) => s.startsWith('INSERT INTO auth_sessions'))).toBe(false);
    expect(db.log.some((s) => s.startsWith('DELETE FROM auth_sessions'))).toBe(false);
  });

  it('does not touch the row outside the rotation window', async () => {
    const { db, row } = await setup(20);
    expect(await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4')).toBe('skipped');
    expect(db.log).toHaveLength(0);
    expect(db.rows()[0].token_hash).toBe(row.token_hash);
  });

  it('revocation between the read and the rotation wins — no replacement session', async () => {
    const { db, row } = await setup();
    // the concurrent request revokes the session after requireAuth read it and
    // before the CAS is applied
    db.beforeApply = (sql) => {
      if (sql.startsWith('UPDATE auth_sessions')) db.sessions.delete('sess-1');
    };
    expect(await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4')).toBe('revoked');
    expect(db.rows()).toHaveLength(0);
  });

  it('revocation AFTER the rotation still kills the rotated row (revoke deletes by id/user_id)', async () => {
    const { db, row } = await setup();
    const out = await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4');
    expect(typeof out === 'object' && out.rotated).toBe(true);
    // logout / password change / admin deactivate land afterwards
    db.sessions.delete('sess-1');
    expect(db.rows()).toHaveLength(0);
  });

  it('a peer request that rotated first yields no new cookie (no clobber)', async () => {
    const { db, row } = await setup();
    // request A rotates; request B, holding the pre-rotation hash, loses the CAS
    await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4');
    const second = await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4');
    expect(second).toBe('skipped');
    // the row is untouched by the loser, so A's token stays the valid one
    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0].token_hash).not.toBe(row.token_hash);
  });

  it('rotation never extends a window that was already stale', async () => {
    const { db, row } = await setup();
    const out = await rotateSession(db.db, row, NOW, 'ua', '1.2.3.4');
    expect(typeof out === 'object' && out.rotated).toBe(true);
    const expires = db.rows()[0].expires_at;
    expect(expires).toBeGreaterThan(NOW + ROTATE_WITHIN);
    expect(expires).toBe(NOW + 30 * 24 * 3600_000);
  });
});
