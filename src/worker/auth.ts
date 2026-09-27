// Auth primitives: PBKDF2 password hashing, opaque tokens, hashed-at-rest storage,
// and a swappable email sender (Resend adapter; console fallback for dev).

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

import type { Env } from './env';
export type { Env };

// Top-10k common-password rejection (NFR-3) — shared by login, password change
// and admin user creation.
import passwordList from './10k-most-common.txt';
const COMMON = new Set(
  passwordList
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0),
);
export const isCommonPassword = (pw: string) => COMMON.has(pw);

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/**
 * Password hashing. Format: `<scheme>$<iterations>$<saltHex>$<hashHex>`,
 * verified with a constant-time compare.
 *
 * SCHEMES. The scheme identifier is load-bearing, not decoration:
 *
 *   `pbkdf2-chain` — what this code produces. It is NOT plain
 *     PBKDF2-HMAC-SHA256 at <iterations>: the Workers runtime rejects a single
 *     `deriveBits` call above 100 000 iterations, so the total is reached by
 *     CHAINING rounds, each feeding the previous 32-byte output back in as the
 *     password with the salt fixed (see pbkdf2Chain). It matches a single call in
 *     work factor only; it is a different construction, and anyone reading the
 *     stored string must not conclude otherwise.
 *
 *   `pbkdf2` — the legacy label, accepted for hashes written before the scheme
 *     was renamed. Same chained derivation, same work factor: only the label
 *     differed, so verification is identical and nothing needs re-hashing. It is
 *     kept ONLY so existing rows and the seeded admin hash (migrations/0002)
 *     keep verifying.
 *
 * A new scheme must ship a new label and a verifying fallback for what is
 * already stored, exactly as this rename did.
 */
const SCHEME = 'pbkdf2-chain';
const LEGACY_SCHEMES = new Set([SCHEME, 'pbkdf2']);

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Chain(password, salt, iterations);
  return `${SCHEME}$${iterations}$${[...salt].map((b) => b.toString(16).padStart(2, '0')).join('')}$${hex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, hashHex] = stored.split('$');
  if (!LEGACY_SCHEMES.has(scheme) || !iterStr || !saltHex || !hashHex) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  // malformed stored hashes (e.g. odd-length salt hex) verify to `false`,
  // not crash with a TypeError
  const saltMatches = saltHex.match(/.{2}/g);
  if (!saltMatches || saltHex.length % 2 !== 0) return false;
  const salt = new Uint8Array(saltMatches.map((h) => parseInt(h, 16)));
  const bits = await pbkdf2Chain(password, salt, iterations);
  const a = hex(bits);
  // constant-time-ish compare
  if (a.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

function pbkdf2(password: BufferSource, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  return crypto.subtle
    .importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
    .then((key) =>
      crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256),
    );
}

// The Workers runtime rejects a single PBKDF2 deriveBits call above 100,000
// iterations. To reach the configured counts (NFR-3: 600k), rounds are chained:
// each round feeds the previous 32-byte output back in as the password, with
// the salt fixed.
//
// This matches a single 600k call in WORK FACTOR only. It is a chained
// construction, not PBKDF2-600k, which is why the stored string is labelled
// `pbkdf2-chain` rather than `pbkdf2` — see the scheme note above. Any
// future standard-compliant alternative must ship with a new label and a
// verifying fallback for what is already stored.
const PBKDF2_MAX_ITERATIONS = 100_000;

async function pbkdf2Chain(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  let pass: BufferSource = enc.encode(password);
  let bits = new ArrayBuffer(0);
  for (let done = 0; done < iterations; done += PBKDF2_MAX_ITERATIONS) {
    const n = Math.min(PBKDF2_MAX_ITERATIONS, iterations - done);
    bits = await pbkdf2(pass, salt, n);
    pass = new Uint8Array(bits);
  }
  return bits;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- email (swappable provider behind a thin interface, spec §6) ----------

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function getEmailSender(env: Env): EmailSender {
  if (env.RESEND_API_KEY) {
    return {
      async send(to, subject, text) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, text }),
        });
        if (!res.ok) {
          // Never log email bodies (NFR-3); status only.
          console.error(`email send failed status=${res.status}`);
          throw new Error('email_send_failed');
        }
      },
    };
  }
  // Dev fallback: log to console only (never a real delivery). The body contains
  // token links — redact unless EMAIL_DEV_MODE is on (dev-only surfaces links in
  // API responses too), so tokens never land in retained Worker logs in prod.
  return {
    async send(to, subject, text) {
      const dev = env.EMAIL_DEV_MODE === '1';
      console.log(`[dev-email] to=${to} subject=${subject}${dev ? ` body=${text}` : ' (body redacted)'}`);
    },
  };
}
