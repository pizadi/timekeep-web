// PBKDF2 hash/verify round-trips, including the Workers runtime constraint:
// a single deriveBits call is capped at 100,000 iterations, so higher counts
// must be split into chained rounds (src/worker/auth.ts pbkdf2Chain).
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/worker/auth';

describe('password hashing (NFR-3)', () => {
  it('round-trips a chained 600k-iteration hash', async () => {
    const hash = await hashPassword('correct horse battery staple', 600_000);
    expect(hash.startsWith('pbkdf2$600000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password 123', hash)).toBe(false);
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
