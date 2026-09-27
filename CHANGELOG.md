# 0.5.4.dev1 – 0.5.4.dev14

Fourteen dev iterations against a second adversarial audit. The theme is the
same as last time but the teeth are in the invariants: a revoked session can no
longer be resurrected by a rotation already in flight, overlapping sessions are
rejected _inside_ the write, a mutation and the event announcing it commit
together, deleting shared metadata no longer destroys other people's history,
and production deploys are gated on the full CI suite passing for the exact sha.

## Security & correctness

- **Session rotation is a compare-and-swap (INV-01)** — renewal used to INSERT
  a new `auth_sessions` row and DELETE the old one, so a revocation landing
  between the read and the insert was silently undone and a stolen token became
  a fresh valid session. It is now one `UPDATE … WHERE id = ? AND token_hash =
<the hash that was read>`: 0 affected rows means the session is gone (401), or
  a peer rotated first (no cookie set, so two racing requests cannot clobber
  each other's token). Every revocation path deletes by `id` or `user_id`, so a
  revoke that lands after the CAS still catches the renamed row.
- **`requireAuth` runs once per request** — every route file registers both a
  bare path and its wildcard (`use('/me', …)` + `use('/me/*', …)`) and Hono
  matches a bare path against BOTH, so the second run re-authorized against the
  now-stale request cookie. That doubled the session/user lookups on every bare
  path and 401'd any request inside the 7-day rotation window, signing the user
  out once per 30 days.
- **Login checks the bot challenge before charging the lockout budget** — the
  route charged both rate-limit counters and only then verified Turnstile, so an
  anonymous caller that never solved the challenge could burn a known username's
  whole 10-per-15-minutes budget from any number of IPs.
- **Password-reset fan-out is bounded per IP (audit #11)** — an accepted reset
  request SENDS MAIL; only a per-address budget existed, so one source could
  spray many addresses. New `reset_ip` (20/hour/IP) ahead of the challenge and
  the per-address rule, so a refused challenge charges the IP budget only.
- **Reset and verification links use a configured origin (INV-09)** — the emailed
  link IS the credential, and its origin came from the request. `APP_PUBLIC_URL`
  wins now; the deploy workflow warns (non-blocking) when it is unset.
- **WebSocket connections are capped and re-authorized (INV-10)** — a valid or
  leaked session could open unbounded sockets, each a live WebSocket in the
  user's Durable Object and a target of every broadcast. The DO now refuses past
  8 per session / 32 per account, and re-reads the session row at upgrade time so
  a revocation in the gap between the Worker's check and the DO's still wins.
- **Deletes tombstone instead of cascading (INV-06)** — `time_sessions.task_id
REFERENCES tasks(id) ON DELETE CASCADE` meant one member deleting a shared task
  erased every OTHER member's historical records. Tasks and projects now carry
  `deleted_at`, the row keeps its name, and `time_sessions.task_name` snapshots
  it at write time. Invisible to every live path; present in reports and the log.
- **Mutation and event commit together (INV-11)** — the client's only recovery
  path is `GET /sync?since=<cursor>`, a pure cursor walk that never refetches, so
  a write whose event was lost was not eventually consistent but permanently
  divergent. `commitWithEvents` makes it one D1 batch, and a convention test
  fails if a handler reverts to the two-batch shape.
- **Overlapping sessions are rejected inside the write (INV-03)** — the route
  selected the conflicts, then inserted, so two concurrent requests both saw "no
  overlap" and both inserted. The overlap predicate and the per-account session
  cap now live in the INSERT/UPDATE itself.
- **Migration 0002's duplicate-username backfill actually de-duplicates** —
  `SELECT id … GROUP BY username HAVING COUNT(*) > 1` returns one arbitrary row
  per group, so a group of three+ left collisions and the unique index failed,
  aborting the migration mid-file.
- **A write spends a DAILY budget, not just a per-minute one (INV-12)** — a
  request cap says nothing about database cost (300/min is ~432k requests/day
  for one account), and the DO's in-memory counters were reset by eviction, which
  a 24-hour cap cannot survive.

## Deployment

- **Deploys are gated on the full CI suite for that exact sha (INV-07)** — the
  "CI gate" was `typecheck && tests`, a strictly weaker gate than the CI
  workflow: lint, format and the whole e2e/security suite were not required. The
  gate now polls this commit's check runs and requires verify + version-sync +
  e2e all green, reporting the CI run's URL on every failure path. CI also runs
  on `v*` tags, since a tag is a different ref from main.

## Housekeeping

- `check-version.mjs` guards `package-lock.json` too — 0.5.3 shipped with a
  lockfile still saying 0.5.2, and nothing broke, which is exactly why it needed
  a guard.
- New password hashes are labelled `pbkdf2-chain$`: the Workers runtime caps a
  single `deriveBits` call at 100k, so the 600k total is reached by chaining
  rounds. The legacy `pbkdf2$` label is still accepted (same derivation, only the
  label differed), and the seeded admin hash keeps verifying.
- e2e retry helpers now also retry the proxy's HTTP 500 drop page, not just
  connection-level curl errors — on a security probe, "the CSRF guard returned
  500" is exactly the line a human is tempted to wave away.

## Tests

Twenty-one new unit tests and three new e2e scripts:

- `test/session-rotation.test.ts`, `test/require-auth-once.test.ts` — the CAS
  interleavings and the double-authorization, against a D1 double that can inject
  a concurrent mutation at a chosen point.
- `test/login-lockout.test.ts` — challenge/budget ordering for login and reset.
- `test/public-url.test.ts`, `test/migrations.test.ts` — the reset-link origin,
  and migration 0002 against real SQLite (clean, colliding pair, triple, several
  groups, ids sharing a prefix).
- `test/event-atomicity.test.ts` — the one-batch convention.
- `e2e/session-race-test.mjs`, `e2e/race-test.mjs`, `e2e/tombstone-test.mjs` —
  the three concurrency/consistency invariants, over real HTTP.

Each of the new e2e scripts was verified to have teeth: the session race
resurrects a live session on 24/24 rounds against the old rotation, the overlap
race stores 5–6 rows per round against the old check-then-insert, and the
tombstone test shows another user's minute going to null against the old
cascade.

Not a release: no tag, and `package.json` still reads 0.5.3.
