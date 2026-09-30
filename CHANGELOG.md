# 0.6.1

Security & data-integrity audit fixes. An external code review of the 0.6.0
tree (`.plan/timekeep-web-code-review.md`) produced 19 findings plus a set of
test gaps; every one of them is closed in this release, each behind a
red-first regression test, across eight dev iterations (0.6.1.dev1–dev8).

## Data integrity

- **Account deletion works again — and transfers responsibly (F1).** A user
  with a goal, an owned group, a sent invite or a minted invite link could not
  delete their account (the FKs without `ON DELETE` made `DELETE FROM users`
  a guaranteed 500 that deleted nothing). `DELETE /me` is now one atomic
  batch: owned groups with other members transfer to the earliest-joined
  active member (the deleter's shared projects/tasks/subtasks/dependency rows
  are reassigned to the new owner), solo-owned groups are safe-deleted via the
  group-delete procedure, and `goals` / `group_invites` / `group_invite_links`
  get explicit deletes. The per-user Durable Object is wiped afterwards (new
  internal `/wipe` route) so no ghost state survives.
- **Deleting a group (or its creator) can no longer destroy other members'
  time (F2).** `DELETE /groups/:id` tombstones the group's tasks and detaches
  - tombstones its projects in the same batch BEFORE the delete — the old
    `ON DELETE CASCADE` chain reached every member's sessions and no tombstone
    logic ever ran. History paths already render tombstoned tasks through the
    historical-name snapshot.
- **`group.deleted` is delivered (F8).** The member list is captured before
  the delete and the event fans out to it; previously the post-delete lookup
  found nobody and every open tab kept showing a dead group until reload.

## Backups

- **The nightly dump works (F4).** `tableScan` paged on a non-existent `id`
  column, so the cron 500'd at the fifth table every night and the MPU was
  aborted — dumps could never succeed. Paging is now uniform `rowid` keyset.
- **Complete and secret-free.** The dump manifest grew from 8 to 17 tables
  (nine persistent tables were missing, including `oauth_accounts`) and
  replaces `SELECT *` with explicit column lists that exclude
  `users.password_hash`, `users.totp_secret` and every `token_hash`. A
  Miniflare-based integration test (`test/cron-dump.test.ts`) drives the real
  cron against the real migrations and pins completeness, row counts and
  credential exclusion in both directions.
- **The absence of a bucket is loud** (`SECURITY_backup_not_configured` once
  per run), dump failures log `cron_dump_failed`, and `docs/deployment.md`
  gained a backups section with a rehearsed restore runbook (the restore was
  rehearsed for real against a scratch database).

## Import guards

- **`/import` verifies row ownership (F3).** Importing a file referencing
  another user's project/task ids used to plant tasks in their tree, attach
  sessions to their tasks (leaking the task name into the importer's export)
  and dangle dependency FKs into 500s. Foreign ids are skipped per collection,
  references must resolve to accepted (owned/created-for-you) rows, sessions
  follow the same task-access rule as `POST /sessions`, and per-row skips are
  counted, never fatal.
- **No double-counting on re-import.** An exact same-task/same-range row
  under a different id is skipped (the signature a repeated merge/duplicate
  produces); timer-style partial overlaps still import — the full overlap
  predicate would have silently dropped legitimate restored time.
- **Goals are portable (F19).** Export carries `goals` (never `user_id`);
  import validates scope reachability, guards the per-user cap inside the
  INSERT, and duplicate mode remaps both the goal id and its scope refs.

## Auth hardening

- **No shipped admin credential (F5).** Migration 0012 nulls the seeded
  `changemeasap` hash (guarded so an already-rotated admin is untouched); a
  fresh install's admin cannot log in until `npm run admin:create` generates
  and prints a passphrase once (never argv; refuses to clobber without
  `--force`; hashes with the worker's own chained PBKDF2). The cron now logs
  `SECURITY_admin_unusable` while the hash is NULL.
- **Lockout keys reworked (F6).** The old per-identifier counter let anyone
  who knew a username keep it locked out. Two counters now: a per-(identifier,
  ip) pair (10/15min — one attacker exhausts only their own pair) and an
  identifier-wide ceiling (40/15min — bounds a distributed attack). Both
  env-overridable for tests.
- **Destructive actions require the current password (F7).** `DELETE /me` and
  `/admin/users/:id/password` take a step-up field verified against the
  acting user's hash (422 validation / 403 `bad_password`); both dialogs in
  the web UI require it before the button enables.
- **Reset/verify tokens are consumed atomically (F14).** Both routes claim
  the token with `DELETE … RETURNING` before acting — a concurrent second use
  gets `invalid_token` instead of a race window.
- **Token links fail closed (F9).** With `APP_PUBLIC_URL` unset/invalid
  outside `EMAIL_DEV_MODE`, no reset/verification link is built or sent
  (`SECURITY_public_url_unset`); the unauthenticated reset response keeps its
  shape-identical `{ok:true}`.

## Hardening cleanups

- **CSRF double-submit is unconditional (F11).** The cookie/header comparison
  ran only when an `Origin` header was present — requests that simply omitted
  Origin passed on `SameSite=Lax` alone. It now applies whenever the CSRF
  cookie is present on an unsafe method.
- **`X-Forwarded-For` is dev-gated (F12).** `clientIp` honours the header
  only under `DEV_TRUST_XFF=1`; otherwise `cf-connecting-ip` or a shared
  `unknown` bucket — a rotatable header can never mint fresh rate-limit
  buckets.
- **KV is gone (F16).** The binding, the env type, the deploy-workflow
  variable/scopes and the setup docs are removed; the docs that described
  "KV rate counters" now describe the real atomic D1 upsert + per-user DO
  counters. Rate limits no longer require a KV namespace to deploy.
- **Crypto labels and docs agree (F10).** Docs state that hashes are the
  chained construction (`pbkdf2-chain$…`), that bare `pbkdf2` is a legacy
  verify-only label, and where the KDF lives (`src/worker/pbkdf2.ts`).

## Schema & scale

- **`users.login_email` (F15).** Additive migration 0013 + backfill: the
  nullable column is the authoritative "real mailbox" marker. Mail paths
  derive addresses via `realEmail()` instead of re-deriving `includes('@')`
  per site — reset-request could previously fire mail at a pre-verified
  user's username string. The legacy `email` mirror is kept (UNIQUE
  constraint, export payload, login lookup).
- **Scale envelope documented (F17).** `docs/architecture.md` states the
  current ceilings (whole-tree `/bootstrap`, in-memory export ~100k sessions,
  SVG map ~300 nodes) with the trigger for revisiting each, and why
  `run_worker_first: true` stays (a glob cannot enumerate SPA routes without
  serving header-less shells).

## CSP & 2FA

- **No `'unsafe-inline'` (F13).** `style-src 'self'` +
  `style-src-attr 'none'` + `style-src-elem 'self'`. The flip was
  evidence-first: the tightened policy shipped as Report-Only while the whole
  SPA was browser-driven with zero violation reports — React's `style={{…}}`
  prop mutates CSSOM, which CSP does not govern, so the ~250 inline-style
  sites never needed the exception. `test/csp.test.ts` pins the policy and
  greps for the unsafe style vectors.
- **2FA/passkeys deliberately deferred (F18).** Documented in the
  architecture security section and the admin guide, with the compensating
  controls named and the revisit trigger ("before onboarding external
  users") stated. Schema placeholders stay reserved.

## Tests

- Three new e2e scripts joined the blocking CI job (now **17 scripts, 283
  assertions**): `deletion-test.mjs` (F1/F2/F8 incl. the WebSocket delivery),
  `import-auth-test.mjs` (F3/F19: cross-user import creates nothing, no
  leaks, no double-counting, goals round-trip) and new sections in
  `security-probes.mjs` (the F7 step-up matrix and the F14 concurrent-token
  probe).
- New unit suites: `cron-dump.test.ts` (Miniflare D1+R2 integration over the
  real migrations), `middleware-csrf.test.ts` (F11/F12, red-first),
  `login-email.test.ts` (F15 helper + a real-sqlite3 migration/backfill test);
  `login-lockout.test.ts` rewritten for the new keys and `public-url.test.ts`
  extended for the fail-closed behavior; `validation.test.ts` covers the
  step-up schemas.
