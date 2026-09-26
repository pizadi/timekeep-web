// ULID generation (spec §5.2: ids are unguessable ULID strings).
// Crockford base32, 48-bit time + 80-bit randomness.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
let lastRand: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENC[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomBytes(n: number): number[] {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf);
}

/** Monotonic within the same millisecond (avoids sort ambiguity of bulk inserts). */
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    // increment the 80-bit randomness as a base-32 counter (least-significant
    // symbol first), with carry — symbols saturate at 31, never exceed the alphabet
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i]! < 31) {
        rand[i] = rand[i]! + 1;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = randomBytes(RAND_LEN).map((b) => b % 32);
  }
  lastTime = now;
  lastRand = rand;
  return encodeTime(now) + rand.map((r) => ENC[r]).join('');
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Uppercase-only to match ids produced by ulid(); see validators.ulidish. */
export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}
