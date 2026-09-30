// Auth primitives: opaque tokens, hashed-at-rest storage, and a swappable email
// sender (Resend adapter; console fallback for dev). The password-hashing core
// (pbkdf2Chain/hashPassword/verifyPassword) lives in ./pbkdf2 and is
// re-exported here — scripts/create-admin.ts imports it without this module
// (the common-password list below is a `.txt` import only the bundler resolves).

import type { Env } from './env';
export type { Env };

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export { hashPassword, verifyPassword } from './pbkdf2';

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
