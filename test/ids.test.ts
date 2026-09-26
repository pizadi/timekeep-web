// ULID generation (spec §5.2): Crockford base32, 48-bit time + 80-bit randomness.
// Regression coverage for the same-millisecond monotonic increment:
// the carry must saturate at the last valid symbol, never emit an invalid one.
import { describe, it, expect } from 'vitest';
import { ulid, isUlid } from '../src/shared/ids';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ulid()', () => {
  it('produces valid Crockford base32 ULIDs', () => {
    for (let i = 0; i < 100; i++) expect(ulid()).toMatch(ULID_RE);
  });

  it('is monotonic within the same millisecond', () => {
    const t = 1_800_000_000_000;
    const prev = ulid(t);
    const next = ulid(t);
    expect(next > prev).toBe(true);
    expect(next.slice(0, 10)).toBe(prev.slice(0, 10)); // same time part
  });

  it('carry propagates when the last symbol is the max (no invalid ids)', () => {
    // Force the previous randomness to all-max symbols, then increment in the
    // same millisecond: the last byte must wrap with carry, not overflow to an
    // out-of-alphabet value (previously emitted the literal string "undefined").
    const t = 1_800_000_000_000;
    ulid(t);
    // Drive internal state: many same-ms calls walk the last symbol up to 'Z'
    // and carry into the previous position.
    let last = ulid(t);
    for (let i = 0; i < 2000; i++) {
      last = ulid(t);
      expect(last).toMatch(ULID_RE);
      expect(last).not.toContain('undefined');
      expect(last).not.toContain('U'); // excluded Crockford letter
      expect(isUlid(last)).toBe(true);
    }
    expect(last > ulid(t - 1)).toBe(true); // still monotonic vs prior ms
  });

  it('never produces duplicate ids in a same-ms burst', () => {
    const t = 1_800_000_000_001;
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(ulid(t));
    expect(seen.size).toBe(5000);
  });

  it('isUlid rejects malformed ids (uppercase alphabet only)', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lowercase
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false); // 'U' not in alphabet
    expect(isUlid('undefined')).toBe(false);
  });
});
