// PBKDF2 hash/verify round-trips, including the Workers runtime constraint:
// a single deriveBits call is capped at 100,000 iterations, so higher counts
// must be split into chained rounds (src/worker/auth.ts pbkdf2Chain).
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/worker/auth';

describe('password hashing (NFR-3)', () => {
  it('round-trips a chained 600k-iteration hash', async () => {
    const hash = await hashPassword('correct horse battery staple', 600_000);
    // the label says CHAINED, because that is what it is — a `pbkdf2$` prefix
    // would read as standard PBKDF2-HMAC-SHA256 at 600k, which it is not
    expect(hash.startsWith('pbkdf2-chain$600000$')).toBe(true);
    expect(hash.startsWith('pbkdf2$')).toBe(false);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password 123', hash)).toBe(false);
  });

  it('still verifies the legacy pbkdf2$ label (same derivation, old label)', async () => {
    // Rows written before the rename keep the old prefix; only the label
    // differed, so the derivation is identical and nothing needs re-hashing.
    const legacy = await hashPassword('an-older-secret-value', 1_000);
    const relabelled = legacy.replace('pbkdf2-chain$', 'pbkdf2$');
    expect(relabelled.startsWith('pbkdf2$1000$')).toBe(true);
    expect(await verifyPassword('an-older-secret-value', relabelled)).toBe(true);
    expect(await verifyPassword('not-the-password', relabelled)).toBe(false);
  });

  it('verifies the seeded admin hash from migration 0002 verbatim', async () => {
    // migrations/0002 ships a precomputed hash of 'changemeasap' under the
    // legacy label. It must keep working or every fresh install is locked out.
    const seeded =
      'pbkdf2$600000$cea27753dabc3263979783f4085bcf71$ba577c389e398fd2882f0fee977eaff6e6372093b1c00093f541c2cfd9f2ce71';
    expect(await verifyPassword('changemeasap', seeded)).toBe(true);
  });

  it('rejects an unknown scheme label', async () => {
    const hash = await hashPassword('some-secret-value', 1_000);
    const wrongScheme = hash.replace('pbkdf2-chain$', 'argon2$');
    expect(await verifyPassword('some-secret-value', wrongScheme)).toBe(false);
  });

  it('round-trips multi-round and boundary counts', async () => {
    for (const iterations of [150_000, 100_000, 1_000]) {
      const hash = await hashPassword('another-secret-password', iterations);
      expect(await verifyPassword('another-secret-password', hash)).toBe(true);
      expect(await verifyPassword('another-secret-passworD', hash)).toBe(false);
    }
  });

  it('produces distinct hashes for equal passwords (random salt)', async () => {
    const a = await hashPassword('same-password', 1_000);
    const b = await hashPassword('same-password', 1_000);
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1000$ab$cd')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$notanumber$ab$cd')).toBe(false);
  });
});
