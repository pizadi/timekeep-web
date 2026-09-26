#!/usr/bin/env node
// Seeds the session-rotation race fixture (see scripts/run-e2e.sh →
// run_session_race, and e2e/session-race-test.mjs):
//
//   <out.sql>    one user + N auth_sessions rows that expire in 3 days,
//                i.e. already inside the 7-day rotation window
//   <out.tokens> [{ id, token }, …] — the seeded rows, index-aligned with rounds
//
// The token hashes are sha256(token) — exactly what the login path stores — so
// the seeded rows are ordinary valid sessions, not a special test path. The ids
// are stable strings because the e2e script revokes a session BY ID.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [roundsArg, sqlOut, tokensOut] = process.argv.slice(2);
const rounds = Number(roundsArg);
if (!rounds || !sqlOut || !tokensOut) {
  console.error('usage: gen-session-race-seed.mjs <rounds> <out.sql> <out.tokens.json>');
  process.exit(1);
}

const USER_ID = 'raceuser01';
const now = Date.now();
const expires = now + 3 * 24 * 3600_000; // < SESSION_ROTATE_BEFORE_MS (7 days)
const tokens = Array.from({ length: rounds }, (_, i) => `seeded-race-token-${i}-${now}`);
const sha = (t) => createHash('sha256').update(t).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const statements = [
  `INSERT OR REPLACE INTO users (id, email, username, password_hash, name, timezone, week_start, theme,
     role, active, must_change_password, email_verified_at, created_at, updated_at)
   VALUES (${q(USER_ID)}, ${q(USER_ID)}, ${q(USER_ID)}, NULL, 'Race', 'UTC', 1, 'system',
     'user', 1, 0, ${now}, ${now}, ${now})`,
  ...tokens.map(
    (
      t,
      i,
    ) => `INSERT OR REPLACE INTO auth_sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (${q(`race-sess-${i}`)}, ${q(USER_ID)}, ${q(sha(t))}, 'race', '127.0.0.1', ${now}, ${now}, ${expires})`,
  ),
];

const sessionId = (i) => `race-sess-${i}`;

writeFileSync(sqlOut, statements.join(';\n') + '\n');
writeFileSync(tokensOut, JSON.stringify(tokens.map((token, i) => ({ id: sessionId(i), token }))));
console.log(`session-race fixture: ${rounds} pre-rotation sessions for ${USER_ID}`);
