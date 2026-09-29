# AGENTS.md — TimeKeep Web

Time tracking SPA (React/Vite) + API on Cloudflare Workers, D1, and Durable Objects.
One Worker serves everything: Hono handles `/api/*`, Static Assets serve the SPA
(`run_worker_first: true`). Vite root is `src/web`; the SPA builds to `dist/client`.

Detailed user-facing docs live in `docs/` (index, development, architecture,
testing, deployment, admin-guide) — keep them in sync with real behavior.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR: `verify`
(typecheck + tests + build), `version-sync` (`scripts/check-version.mjs`
guards package.json ↔ wrangler.jsonc `__APP_VERSION__` ↔ package-lock), and a blocking `e2e`
job — `scripts/run-e2e.sh` wipes local state (only when `CI=true`), migrates,
starts `wrangler dev`, and runs all fifteen e2e scripts in order, with one
automatic retry for the proxy flake.

CD: `.github/workflows/deploy.yml` deploys on `workflow_dispatch` and `v*` tag
pushes via the `production` environment (required reviewers = approval gate). Its
`ci-gate` job requires the FULL CI suite (lint · format · typecheck · unit · e2e)
to have passed **for the exact sha being deployed** — it polls, because a tag push
starts both workflows at once. CI therefore also runs on `v*` tags.
Pipeline: CI gate → `scripts/render-wrangler.mjs` renders `wrangler.jsonc` +
GitHub variables into `wrangler.ci.jsonc` (gitignored — resource ids stay out
of the repo) → build → remote D1 migrations → `wrangler deploy` → post-deploy
`GET /api/version` check (package.json version + short deploy sha). Setup
(token scope, secrets, variables) in `docs/deployment.md`.

## Commands

```bash
npm run db:migrate:local    # apply D1 migrations locally — required before first dev/e2e run
npm run dev:worker          # wrangler dev :8787 — API + SPA (there is no `npm run dev`)
npm run dev:web             # Vite :5173, proxies /api incl. WebSockets to :8787
npm test                    # vitest, node env, only test/**/*.test.ts — no DB or network needed
npm run typecheck           # TWO tsc projects (worker + web); always run via this script
npm run build               # SPA → dist/client
npx vitest run test/time.test.ts          # single test file
bash e2e/smoke-test.sh                    # e2e: requires `wrangler dev` in another terminal
```

- Full local check: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`.
  ESLint (flat config, `eslint.config.js`) + Prettier are both wired into CI's `verify` job; run
  `npm run lint:fix` / `npm run format` to apply fixes. Rule posture is deliberate:
  `react-hooks/rules-of-hooks` is an error, `exhaustive-deps` a warning, and `no-explicit-any` is
  off (the store/api layer is `any`-typed at its edges by design). Dead code is caught twice over:
  `noUnusedLocals`/`noUnusedParameters` in both tsconfigs (so `typecheck` gates it) and
  `@typescript-eslint/no-unused-vars` in ESLint.
- E2E scripts (`e2e/smoke-test.sh`, `ws-test.mjs`, `roundtrip-test.mjs`, `undo-test.mjs`,
  `security-probes.mjs`, `regression-check.mjs`, `pomo-mode-test.mjs`) target `127.0.0.1:8787`
  and create their own accounts. They hammer the login endpoint — set `RL_LOGIN_IP`/
  `RL_LOGIN_EMAIL`/`RL_ADMIN_IP` overrides from `.dev.vars.example` in `.dev.vars`
  (but NOT `RL_TOKEN_IP` — `regression-check.mjs` expects the verify-email hammer to actually 429).
  Run `smoke-test.sh` first — the other scripts reuse the users it creates; `roundtrip-test.mjs`
  last (it deletes the `dana` account).
- `wrangler dev`'s local proxy intermittently drops requests under rapid sequential e2e load
  (`Error: Network connection lost` → the script dies on a random step). Re-run before investigating.
- **Killing a `wrangler dev` requires killing its SUPERVISOR, not the listener.** The process tree
  is `npx → node …/wrangler-dist/cli.js dev → workerd` (+ esbuild); `workerd` is merely the
  supervisor's child and is RESPAWNED the moment it dies, so `kill <workerd-pid>` (or killing by
  the port via `ss -tlnp`) never frees :8787 — a fresh workerd reappears seconds later and every
  later `wrangler dev` / `run-e2e.sh` silently talks to the stale one (or dies with
  `Address already in use`). Kill the `node …/wrangler-dist/cli.js dev` process first
  (`pkill -9 -f 'cli\.js dev'`), then any orphaned `workerd`. Two traps: (1) `scripts/run-e2e.sh`'s
  EXIT trap kills only the `npx` wrapper, so an interrupted/failed run can leave the inner
  supervisor orphaned to init (PPID 1) still holding :8787 — check `ss -tlnp | grep 8787` after any
  odd suite run; (2) `pkill -f "wrangler dev"` also matches the invoking shell's OWN command line
  and kills it mid-command — the rest of the line silently never runs. Use a non-self-matching
  pattern (e.g. `[w]rangler`), `pkill -x`, or kill by PID. Never leave a background
  `wrangler dev` running between commands.
- **Temp files and scratch state go in `.work/`** (gitignored, inside the project) — never `/tmp`.
  Cookie jars, throwaway D1/KV state for a local `wrangler dev --persist-to`, ad-hoc verification
  scripts, build logs. Same machine, same repo, and it survives a reboot's `/tmp` cleanup.

## Env

- Copy `.dev.vars.example` → `.dev.vars` (gitignored). Everything is optional in dev;
  `EMAIL_DEV_MODE=1` logs verification/reset links to the Worker console (API responses
  never carry live token links).
- Prod uses `PBKDF2_ITERATIONS=600000`; dev lowers it to 1000. Workers caps a single
  PBKDF2 `deriveBits` call at 100k iterations (`pbkdf2Chain` in `src/worker/auth.ts` chains
  rounds to reach the total) — never call `crypto.subtle.deriveBits` with PBKDF2 > 100k directly.
- Schema changes go in a new numbered file under `migrations/`, then `db:migrate:local` /
  `db:migrate:remote`.
- D1 gotcha: `PRAGMA legacy_alter_table=ON` is ignored and `ALTER TABLE … RENAME` rewrites child
  FK `REFERENCES`, so a table rebuild of any referenced table (e.g. `users`) makes `DROP TABLE`
  cascade-delete every child row. Additive `ADD COLUMN` migrations only (see 0003 — that's why
  `week_start_dow` exists beside the CHECK-constrained legacy `week_start`).

## Deploy & versioning

- `wrangler.jsonc` (committed) is a template with `REPLACE_ME` resource ids — the real D1/KV ids
  live in the gitignored `wrangler.local.jsonc`. Deploy with
  `npm run build && npx wrangler deploy -c wrangler.local.jsonc`; remote D1 migrations likewise
  need `-c wrangler.local.jsonc` (`npm run db:migrate:remote` alone reads the template).
- **Route all Cloudflare access through `proxychains`** — `proxychains npx wrangler …`,
  `proxychains curl https://…workers.dev…` (local proxy 127.0.0.1:2080, configured in
  `/etc/proxychains.conf`).
- Live check: `GET https://timekeep-web.parham-avia.workers.dev/api/version` →
  `{version: semver, build: deploy-sha}`.
- Version source of truth is `package.json`; the SPA gets it via the Vite `define` (Settings
  footer), the worker via the `__APP_VERSION__` define — present in BOTH wrangler configs'
  `define` blocks. On release: bump all three, commit, then annotated tag `vX.Y.Z`.
- Version strings are always `x.x.x` (release) or `x.x.x.devN` (dev iteration — N incremental
  from 1: `0.2.0.dev1`, `0.2.0.dev2`, …). No other spellings (`-dev.`, `devN` without the base).
- **Never create a non-dev release unprompted.** Dev versions (`X.Y.Z.devN` commits/iterating)
  are fine, but a real release — a clean `X.Y.Z` version bump, release commit or `vX.Y.Z` tag —
  happens ONLY after the user live-tests the build and explicitly tells me to release.
- **Every non-dev commit must be tagged:** after a clean `X.Y.Z` release commit, create the
  matching annotated `vX.Y.Z` tag. Dev commits are never tagged. The Deploy workflow is
  release-only and runs from that tag; its tag filter excludes `v*.dev*` and
  `scripts/check-release-tag.mjs` fails a tagged run whose package.json isn't a clean
  `x.y.z` matching the tag (belt and braces — don't tag dev iterations anyway).

## Architecture rules

- `src/shared/` is isomorphic — included by BOTH `tsconfig.worker.json` and `tsconfig.web.json`.
  Changes there must typecheck in both (this is why `typecheck` runs two projects).
- Single-timer invariant: partial unique index `time_sessions(user_id) WHERE ended_at IS NULL`
  in D1 + `UserHub` DO (`src/worker/do/user-hub.ts`) as the operational authority. Never write
  per-tick rows.
- Time: instants are epoch-ms UTC everywhere. Day/week bucketing uses the `Intl`-based engine in
  `src/shared/time.ts` fed into SQL via a `json_each()` day table — don't move aggregation
  client-side; API clients receive report buckets, never raw session rows. The profile timezone
  is seeded from the device on `boot()` ONLY while it still holds the `'UTC'` default that
  `routes/admin.ts` writes — never overwrite a zone the user picked in Settings.
- Recency ("Jump back in" / Resume) is subtask-aware: `/api/bootstrap` returns
  `recent: [{ task_id, subtask_id }]` (newest session per task, via a window function) and the
  client keeps those pairs in `recentEntries` (`src/web/lib/recent.ts` — pure, unit-tested).
  Keep task-level-only recency out; Resume must restore the subtask.
- Goals (`src/shared/goals.ts`, v0.6.0): "X minutes per day/week/month on a scope of
  project/task/subtask refs" (`goals.scope`, JSON `"kind:id"`), direction `at_least`/`at_most`.
  Status is DERIVED, never stored — `goalStatus()` reads `archived_at`/`ends_at` + the live
  done-states of the scope refs, so nothing hooks task toggles and un-checking re-activates a
  completed goal; no `completed_at` column exists. First and last partial periods are PRO-RATED
  (ceil, min 1 min). Progress is server-side only (`GET /api/goals/progress`, json_each windows
  like reports, running session included; one `DB.batch`, two statements per goal) — the client
  never derives tracked time. Goal DELETE is a hard delete (nothing references goals; the
  client's undo re-creates). The per-user cap is a guarded INSERT (`LIMITS.goalsPerUser`).
  Period-end notifications are client-side (`lib/goalNotify.ts`, no new permission requests).
- Every mutation appends to `sync_log`, then the DO fans out (`src/worker/events.ts`,
  notify via `ctx.waitUntil`). Batch granularity: the UserHub DO writes entity rows and
  events in ONE D1 batch; route handlers use two back-to-back batches (entity write, then
  events) — a crash between them can drop the event, clients recover via the reconcile poll.
- Every request body is Zod-validated (`src/worker/validators.ts`); ownership checks are always
  `WHERE user_id = ?`.
- Subtasks are exactly two levels deep (enforced in validators and routes).
- Admin-managed accounts: there is NO self-signup (`/auth/signup` returns 404 and no UI exists).
  A single admin (`username: admin`) is seeded by `migrations/0002_usernames_admin.sql` with
  password `changemeasap` + `must_change_password=1` (forced change at first login). Users are
  created/deactivated via `/api/admin/*` (`routes/admin.ts`, `requireAdmin`).
- Login identifier is the `username` column (`users.email` is only an optional reset-mail address;
  users without one store their username there). The `must_change_password` gate in `requireAuth`
  blocks every endpoint except `GET /api/me`, `POST /api/me/password`, `POST /api/auth/logout`.
- "Remove user" means deactivation (`active=0` + session revocation) — user data is never deleted
  from the admin panel; the admin account cannot be deactivated or self-deleted.
- Pomodoro is an opt-in replacement for the simple timer: `settings.pomodoro.enabled` (default
  false). When on, plain `/timer/start` engages the DO's focus cycle (fresh from idle/decide/ready;
  starting during a break cancels it) and sessions are tagged `source: 'pomodoro'`;
  `/timer/switch` re-anchors the cycle. Soft timeouts only — nothing ever auto-stops; disabling
  mid-cycle resets the cycle but keeps the timer running.
- The acting device IGNORES its own WS echoes (`ev.actor === deviceId` guard in
  `store.applyEvent`) — timer/pomo API responses carry `pomo`/`running` payloads the caller must
  apply via `store.setPomo`/`store.setRunning`, or the UI state goes stale.
- Social layer (phases 1–4): friends, project visibility, groups, chat, group projects.
  - Cross-user fan-out = `emitToUsers` (events.ts): ONE sync_log row per recipient (per-user
    AUTOINCREMENT ids — the existing `/sync` cursor logic is untouched) + a notify of each
    recipient's UserHub. State-change events are SIGNALS (clients refetch the small social
    lists); payload-carrying events are `friend.timer` (presence) and `group.message_*` (chat,
    relayed to open panels via the `tk:group-message` CustomEvent).
  - Group authorization lives in `worker/group-auth.ts` (`requireGroup` → 404 outsiders,
    `requireGroupPerm` → 403) over per-member permission flags (`GROUP_PERMS` in
    shared/constants, stored as JSON on `group_members.perms`; owner implicit-all, and only the
    owner grants/revokes). Group-project access resolution (`resolveProjectAccess` /
    `requireEditTasks`) lives in `worker/access.ts` — group tasks are shared (any member with
    `edit_tasks` edits), sessions stay strictly user-owned.
  - Friend-visible projects require `visibility='friends' AND group_id IS NULL` — the two
    sharing mechanisms (friends ↔ groups) never cross. Presence/chat never expose raw session
    rows or notes; reports are buckets only.
  - Deletes TOMBSTONE, never cascade: `tasks`/`projects` carry `deleted_at` and the row keeps its
    name. `time_sessions.task_id … ON DELETE CASCADE` used to mean one member deleting a shared
    task destroyed every OTHER member's history (INV-06). `access.ts` treats a tombstone as
    nonexistent for every live path (404, listings, "jump back in", un-startable), while reports
    and the session log render it through `HISTORICAL_TASK_NAME` (live name, else the session's
    `task_name` snapshot). Sessions are still the owner's to delete outright. Undo/import clear
    `deleted_at` on their upserts; a tombstoned project yields its name on recreate (renamed to
    `<name> (deleted <date>)` in the same batch, because `projects` keeps its inline UNIQUE and a
    partial index would need a table rebuild).
  - Deletion integrity (audit F1/F2/F8): `DELETE /groups/:id` tombstones the group's tasks and
    detaches + tombstones its projects in the same batch BEFORE `DELETE FROM groups` (the
    `projects.group_id` CASCADE would otherwise destroy every member's sessions), and emits
    `group.deleted` to the member list captured BEFORE the delete. `DELETE /me` deletes the
    FKs-without-ON-DELETE rows explicitly (`goals`, `group_invites`, `group_invite_links`),
    transfers each owned group with remaining active members to the earliest-joined one
    (owner decision D1) or safe-deletes solo ones, and reassigns the deleter's shared
    rows (projects/tasks/subtasks/task_dependencies all carry a denormalized `user_id`) to the
    surviving group's owner — all in ONE atomic batch; then the UserHub DO is wiped via the
    internal `/wipe` route (`ctx.storage.deleteAll()`).
  - Rate limits: `social_user` bucket (friend requests, username lookups, joins, invite/link
    minting; `RL_SOCIAL_USER`), chat sends ride `limitHeavy`. Invite-link tokens are stored as
    SHA-256 hashes and returned exactly once.
- **State-changing writes are throttled by `limitWrites`** (`write_user`, 300/min, **plus
  `write_user_day`, 20k/day**) — the CRUD/task/session/timer/group routes had no rate limit at all
  before, only eventual entity-count caps. The DAILY budget is the one that bounds database work:
  a per-minute request cap says nothing about cost, and one account could otherwise drive ~432k
  requests a day. Fan-out routes (group projects, membership, chat — one request writes a
  `sync_log` row per member) use **`limitSocialWrites`** (`social_write`, 60/min) INSTEAD, because
  chaining both would spend the day budget twice. Chained after `requireAuth` in the `use(...)` of
  every mutating route file (chat edits, `/me`, and misc's settings/layout take it per-route);
  reads are skipped (they ride `api_user` via `limitHeavy`) and a per-request flag keeps a single
  write counted once even when two route files match the same path. Never add a mutating route
  without it. The DO's counters live in the DO's own storage, not memory — a cap that forgets
  itself when the instance is evicted is not a cap.
- **Capacity caps are enforced inside the INSERT/UPDATE, never by a prior
  `SELECT COUNT(*)`** (audit 🟡2). D1 serializes writes per database, so a guarded statement
  (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < ?` plus a `meta.changes` check) cannot be
  raced, while count-then-insert can overshoot the cap. Applies to group creation, join-by-link
  (member cap _and_ the link's `use_count < max_uses`), invite accept, invite-link minting,
  friend requests, and friend-request accept (both friendship rows in ONE guarded statement so
  the pair is all-or-nothing). Keep the same 422 `limit` error when `changes` comes back short.
  The same rule governs the session overlap/cap guards (`INSERT_SESSION_GUARDED` /
  `UPDATE_SESSION_GUARDED` in `rules.ts`, exported as SQL so they can share a batch with their
  event). A guarded write that matches zero rows still appends its event, so read the ENTITY
  statement's `meta.changes` (`rules.wroteOne`) — never the event count, which reports a lost
  race as a success.
- End-of-run pomodoro notifications (`decide`/`ready` phases) bypass the `notifications_enabled`
  toggle (they need only browser permission, requested when pomodoro is enabled in Settings);
  every other notification respects the toggle. Notification permission is never requested
  anywhere else.
- No native `<datalist>` pickers — use `src/web/components/Combobox.tsx`. Inside modals/grids,
  `.input` needs `min-width: 0` and `1fr` tracks must be `minmax(0, 1fr)` (a `datetime-local`'s
  intrinsic width overflows the dialog otherwise — the v0.1.0 dialog-clip fix).
- Responsive UI (details in `docs/architecture.md`): three width tiers (<640 phone,
  640–1023 tablet/drawer, ≥1024 desktop) live in `styles.css` and mirror `BREAKPOINTS`
  in `src/web/lib/responsive.ts`. `(pointer: coarse)` scales touch targets (44px class)
  and forces 16px inputs (iOS focus zoom); all `:hover` effects are gated behind
  `(hover: hover)`. Every keyboard/hover interaction has a touch path — sidebar project/task
  ⋯ menus on every screen, map node ⋯ menu + pinch/zoom buttons, log card rows on phones,
  full-screen modal sheets. Truncation policy: ellipsis → auto-scrolling horizontally on
  fine-pointer hover, 2-line clamp on touch, `title` tooltip on every truncation site. Don't
  add hover- or keyboard-only affordances without their touch equivalent.

## Commits

- Commit messages are `<version> — <one-line description>`: the version being committed, an
  em dash, then the description (optionally 1–2 body lines after that).
- Each RELEASE (non-dev `x.x.x`) version ships a `CHANGELOG.md` that briefly describes
  everything changed in the repo since the previous release.
- Changelogs don't accumulate — the newest release's changelog overwrites the file
  (git history keeps the old ones).
- `AGENTS.md` is updated with every major change in the codebase.
