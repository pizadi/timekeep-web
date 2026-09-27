# 0.5.4

Eighteen dev iterations against a second adversarial audit. Same shape as 0.5.3
— invariants, not patches — but the teeth are in the interleavings: a revoked
session can no longer be resurrected by a rotation already in flight, overlapping
sessions are rejected _inside_ the write, a mutation and the event announcing it
commit together, deleting shared metadata no longer destroys other people's
history, and production deploys are gated on the full CI suite passing for the
exact sha.

## Data integrity

- **Deletes tombstone instead of cascading (INV-06).** `time_sessions.task_id
REFERENCES tasks(id) ON DELETE CASCADE` meant one member deleting a shared task
  erased every _other_ member's historical records — and reports and exports are
  the point of the app. `tasks`/`projects` now carry `deleted_at` and the row keeps
  its name; `time_sessions.task_name` snapshots it at write time. A tombstone is
  invisible to every live path (404, listings, position ordering, "jump back in",
  un-startable) and fully present in reports and the session log. Additive
  migration only, so no table is rebuilt and no FK child is disturbed.
  - A tombstoned project yields its name on recreate — the tombstone is renamed to
    `<name> (deleted <date>)` in the same batch, before the insert. `projects`
    keeps its inline `UNIQUE(user_id, name)` on purpose: a partial index would
    need a table rebuild, which cascades.
  - Undo and import now clear `deleted_at` on their upserts; without that, "undo"
    silently did nothing.
  - A running timer on a tombstoned task is **ended**, not left running: the user
    can no longer see the task, and the single-timer invariant would otherwise
    block them from starting anything else. The row and its duration survive.
- **Overlapping sessions are rejected inside the write (INV-03).** The route
  selected the conflicts, then inserted, so two concurrent requests both saw "no
  overlap" and both inserted. The overlap predicate and the 200k per-account cap
  now live in the INSERT/UPDATE itself — D1 serializes writes per database, so a
  guarded single statement cannot be raced. The pre-check remains, but only to
  build the 409 body the UI highlights.
- **Mutation and event commit together (INV-11).** The client's only recovery path
  is `GET /sync?since=<cursor>`, a pure cursor walk that never refetches, so a
  change whose event was lost was not eventually consistent — it was permanently
  divergent until a full reload. `commitWithEvents` puts the entity write and its
  `sync_log` append in one D1 batch, everywhere, and a convention test fails if a
  handler reverts to the two-batch shape. Documented exceptions:
  `import.completed` / `restore.completed` are completion signals for multi-batch
  operations and are refetch-triggering by design.
- **Migration 0002's duplicate-username backfill actually de-duplicates
  (INV-13).** `SELECT id … GROUP BY username HAVING COUNT(*) > 1` returns one
  arbitrary row per group, so a group of three or more left collisions and
  `CREATE UNIQUE INDEX` failed, aborting the migration mid-file. The statement now
  selects the colliding _usernames_ and suffixes with the full id.

## Security

- **Session rotation is a compare-and-swap (INV-01).** Renewal used to INSERT a
  new `auth_sessions` row and DELETE the old one, so a revocation landing between
  the read and the insert was silently undone and a stolen token became a fresh
  valid session. It is now one `UPDATE … WHERE id = ? AND token_hash = <the hash
that was read>`: zero affected rows means the session is gone (401), or a peer
  rotated first (no cookie set, so racing requests cannot clobber each other's
  token). Every revocation path deletes by `id` or `user_id`, so a revoke that
  lands after the CAS still catches the renamed row.
- **`requireAuth` runs once per request.** Every route file registers both a bare
  path and its wildcard (`use('/me', …)` + `use('/me/*', …)`), and Hono matches a
  bare path against BOTH — so auth ran twice, doubling the session and user
  lookups, and the second run re-authorized against the request cookie that a
  rotation had already replaced. Inside the 7-day rotation window that 401'd a
  request the first run had authorized, signing the user out once per 30 days.
- **The login bot challenge is verified before the lockout budget is charged.**
  Both rate-limit counters were charged first, so an anonymous caller that never
  solved Turnstile could burn a known username's whole 10-per-15-minutes budget
  from any number of IPs.
- **Password-reset fan-out is bounded per IP.** An accepted reset request SENDS
  MAIL; only a per-address budget existed, so one source could spray many
  addresses. New `reset_ip` (20/hour/IP) ahead of the challenge and the
  per-address rule, so a refused challenge charges only the IP budget.
- **Reset and verification links use a configured origin (INV-09).** The emailed
  link IS the credential, and its origin came from the request — so any Host
  header the deployment accepted could aim the token at another domain. New
  `APP_PUBLIC_URL` wins; the deploy workflow warns (non-blocking) when unset.
- **WebSocket connections are capped and re-authorized (INV-10).** A valid or
  leaked session could open unbounded sockets, each a live WebSocket in the user's
  Durable Object and a target of every broadcast. The DO now refuses past 8 per
  session / 32 per account, and re-reads the session row at upgrade time, so a
  revocation in the gap between the Worker's check and the DO's still wins.

## Cost & abuse limits

- **Writes are bounded by cost, not by request count (INV-12).** A per-minute
  request cap says nothing about what a request costs the database — 300/min is
  ~432k requests/day for one account — and social mutations write a `sync_log`
  row per group member on top. Added `write_user_day` (20k/day) alongside
  `write_user`, both charged in one round trip, and `social_write` (60/min) for
  the fan-out routes, which use it _instead_ so the daily budget is not spent
  twice. The DO's per-user counters moved from memory into the DO's own storage:
  a 24-hour cap that resets on eviction is not a cap.

## Deployment

- **Deploys are gated on the full CI suite for that exact sha (INV-07).** The "CI
  gate" was `typecheck && tests` — a strictly _weaker_ gate than the CI workflow
  it claimed to mirror, so a release could ship with a failing e2e or security
  probe. A new `ci-gate` job reads this commit's check runs and requires verify +
  version-sync + e2e all green, polling because a tag push starts both workflows
  at once, and reporting the CI run's URL on every failure path. CI also runs on
  `v*` tags, since a tag is a different ref from main.

## Dependencies

- **Vite 5 → 8, Vitest 2 → 5, plugin-react 4 → 6: 0 vulnerabilities.** Vite 8
  replaces esbuild with rolldown, so the dev-server advisory is retired by
  construction rather than by a version floor. Two behaviour changes came with it
  and are handled: the dev server binds IPv6 loopback only (`server.host` pinned
  to 127.0.0.1, which serves both URL spellings and matches the API proxy
  target), and `vite.config.ts` moved off `__dirname` and a bare JSON import,
  which a future Vite major rejects under its native config loader.
  `engines.node: >=22.12.0` records the floor Vite 8 and Vitest 5 require.
- `check-version.mjs` guards `package-lock.json` too — 0.5.3 shipped with a
  lockfile still saying 0.5.2, and nothing broke, which is exactly why it needed a
  guard.
- `allowScripts` uses bare package names. It pinned `workerd@1.20260911.1`
  exactly, and a transitive bump had already moved it; npm reports a blocked
  install script only as a warning, so `wrangler dev`'s binary would simply be
  missing in CI.

## Correctness notes

- New password hashes are labelled `pbkdf2-chain$`: the Workers runtime caps a
  single `deriveBits` call at 100k, so the 600k total is reached by chaining
  rounds. The legacy `pbkdf2$` label is still accepted (same derivation, only the
  label differed), and the seeded admin hash from migration 0002 keeps verifying.
- e2e retry helpers now catch the proxy's HTTP 500 drop page as well as
  connection-level curl errors. On a security probe, "the CSRF guard returned
  500" is exactly the line a human is tempted to wave away as a local artifact;
  that indistinction is also how a dropped password change used to pass silently
  in `smoke-test.sh` and fail several scripts later in `ws-test.mjs`.

## Tests

Twenty-one new unit tests and three new e2e scripts (14 e2e total), covering:

- `session-rotation` / `require-auth-once` — the CAS interleavings and the double
  authorization, against a D1 double that can inject a concurrent mutation at a
  chosen point.
- `login-lockout` — challenge/budget ordering for login and reset.
- `public-url` / `migrations` — the reset-link origin, and migration 0002 against
  real SQLite (clean, colliding pair, triple, several groups, ids sharing a
  prefix).
- `event-atomicity` — the one-batch convention.
- `session-race`, `race`, `tombstone` — the three concurrency/consistency
  invariants over real HTTP.

Each new e2e script was verified to have teeth by re-running it against the old
code: the session race resurrects a live session on 24/24 rounds against the old
rotation (0/24 after), the overlap race stores 5–6 rows per round against the old
check-then-insert (1 after), and the tombstone test shows another user's minute
going to null against the old cascade (unchanged after).
