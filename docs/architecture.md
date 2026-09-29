# Architecture

How TimeKeep Web works, in depth. Requirement IDs (`FR-*`, `NFR-*`) refer to the
requirements spec; coverage tables live in
[requirement-coverage.md](requirement-coverage.md).

## One Worker serves everything

A single Cloudflare Worker is the whole backend and the whole frontend host:

- `src/worker/index.ts` mounts a [Hono](https://hono.dev) app for `/api/*`
  (including WebSocket upgrades at `/api/ws`).
- Cloudflare **Static Assets** serve the built SPA (`dist/client`) with an
  SPA fallback (`not_found_handling: "single-page-application"`).
- `run_worker_first: true` sends every request through the Worker first, so
  security headers apply uniformly to the SPA shell too (a deliberate
  latency/cost tax — see trade-offs).

Route modules (`src/worker/routes/`): `auth`, `me`, `admin`, `projects`,
`tasks`, `sessions`, `timer`, `reports`, `export`, `friends`, `groups`,
`chat`, `misc` (bootstrap/settings/layout/sync/version).

## Storage: D1, KV, and the UserHub Durable Object

| Store                                        | Used for                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** (SQLite)                              | all durable entities: users, sessions, projects, tasks, subtasks, dependencies, `time_sessions`, `sync_log`, email tokens, groups, chat, rate counters |
| **KV**                                       | cold rate-limit counters (per-IP / per-email buckets), misc cache                                                                                      |
| **UserHub DO** (`src/worker/do/user-hub.ts`) | one DO instance per user: WebSocket hub, timer authority, pomodoro state machine, the hot per-user API rate counter                                    |

## Single-timer invariant

A user has at most one running timer, enforced twice:

1. **Database** — a partial unique index on `time_sessions(user_id) WHERE
ended_at IS NULL`, so two rows can never both be open.
2. **UserHub DO** — the operational authority. Timer start/stop/switch go
   through the DO, which serializes them, so two devices can't race a start
   (the loser gets `409 already_running`).

Timer ticks are **never written** — a 24 h running session costs ~2 DB rows
(open + close). Live duration is computed client-side from `started_at`.

## Pomodoro

`settings.pomodoro.enabled` (default off) turns the plain timer into a soft
focus cycle owned by the DO: `idle → focus → decide → ready` with explicit
breaks and skips. Soft timeouts only — nothing ever auto-stops; disabling
mid-cycle resets the cycle but keeps the timer running. Sessions started in
focus are tagged `source: 'pomodoro'`; `/timer/switch` re-anchors the cycle.

## Goals

"X hours per period (day/week/month) on Z" — Z is any mix of project/task/
subtask nodes (`goals.scope`, JSON `"kind:id"` refs; a project ref covers all
its tasks, and scope may include group-project nodes the user can track).
Directions: `at_least` (habit) or `at_most` (limit).

- **Pure math lives in `src/shared/goals.ts`** (unit-locked in
  `test/goals.test.ts`): period windows follow the same `Intl` engine as
  reports (profile timezone + week start); a goal's FIRST and LAST partial
  periods are **pro-rated** by covered time — `ceil`, min 1 minute — so a goal
  expiring 4 days into a week carries a 4/7 target for that week.
- **Status is derived, never stored**: `goalStatus()` computes
  active/completed/expired/archived from `archived_at`, `ends_at`, and the
  live done-states of the scope refs. There is no `completed_at` column and
  nothing hooks task toggles — un-checking a scope item re-activates a
  completed goal. Tombstoned scope items are ignored by the done-check (their
  past sessions still count, matching reports).
- **Progress is server-side** (`GET /api/goals/progress`): period windows go
  back into SQL via `json_each()` exactly like the report day table; clients
  get window buckets + stats, never session rows. The running session is
  included, clipped to `now`. All goals compute in ONE `DB.batch` (two
  statements per goal: per-window tracked ms, and the scope's live/done counts).
- **Deletion is a hard DELETE** — goals are referenced by nothing, so there is
  no tombstone; the client's undo re-creates the goal from the DELETE's
  returned row (fresh id).
- **Cap inside the INSERT** (audit 🟡2): the guarded statement carries
  `WHERE (SELECT COUNT(*) …) < LIMITS.goalsPerUser` (30), `meta.changes` read
  for the 422.
- **Period-end notifications are client-side** (`src/web/lib/goalNotify.ts`):
  when a boundary passes while the app is open, progress is refetched and one
  notification per affected goal fires — only with the Settings toggle on and
  permission already granted (never requested here). No server cron.

## Sync & events

Every mutation appends a row to `sync_log`, then the UserHub DO fans the event
out to the user's connected devices over WebSockets (`src/worker/events.ts`,
notified via `ctx.waitUntil`).

- `sync_log` ids are **per-user AUTOINCREMENT**, so clients poll
  `GET /api/sync?since=<lastId>` for reconnect deltas; a polling fallback
  covers environments where WebSockets are blocked.
- Events are **signals**: clients refetch the small social lists rather than
  trusting payloads. The payload-carrying exceptions are `friend.timer`
  (presence) and `group.message_*` (chat, relayed to open panels via a
  `tk:group-message` CustomEvent).
- The acting device **ignores its own WS echoes** (`ev.actor === deviceId`
  guard in the store) — timer/pomodoro API responses carry `pomo`/`running`
  payloads the caller must apply via `store.setPomo`/`store.setRunning`, or
  the UI state goes stale.
- **Transactionality**: entity write and event are ONE D1 batch, everywhere.
  `commitWithEvents(env, userId, drafts, entityStmts)` is the only way a route
  writes; `emitToUsers`/`emitEntityEvents` take the entity statements as an
  argument so a fan-out is atomic with what it announces. D1 runs a batch as a
  transaction, so "the change happened" and "the change is in the log" are one
  fact. This matters because the client's only recovery path is
  `GET /sync?since=<cursor>` — a pure cursor walk that never refetches — so a
  change whose event was lost is not eventually consistent, it is permanently
  divergent until a full reload. Two exceptions, both documented at the call
  site: `import.completed` and `restore.completed` are completion signals for
  multi-batch operations (up to 200k rows, 200 at a time) and cannot share a
  batch; clients treat both as a full refetch, so losing one is
  stale-until-reload rather than divergence.
  `test/event-atomicity.test.ts` fails if a handler calls the standalone
  `appendEvents` again.
- Cross-user fan-out (friends, groups) uses `emitToUsers`: ONE sync_log row
  per recipient + a notify of each recipient's UserHub.
- **Recency** ("Jump back in" / Resume): `GET /api/bootstrap` returns
  `recent: [{ task_id, subtask_id }]` — one entry per task, newest first,
  carrying the subtask of that task's most recent session (a window function,
  not a `GROUP BY`, which would drop the column). The client keeps the pair in
  `recentEntries` (`src/web/lib/recent.ts`, pure + unit-tested), so Resume,
  the `R` shortcut and the "Jump back in" chips all restart the _subtask_ that
  was last tracked — falling back to the whole task if that subtask is gone.

## Time handling

- Instants are **epoch-ms UTC everywhere** — DB, API, clients.
- Day/week bucketing for reports uses the `Intl`-based engine in
  `src/shared/time.ts` (per-user IANA timezone + week-start day), pushed into
  SQL via a `json_each()` day table — aggregation stays in the database and
  API clients receive report buckets, never raw session rows.
- DST edge cases are locked by unit-test fixtures (Tehran / New York) in
  `test/time.test.ts`.
- The profile timezone is **seeded from the device**: admin-created users get
  the `'UTC'` default, and `store.boot()` corrects it to the browser's IANA
  zone while the profile still holds that untouched default (a zone picked in
  Settings is never overwritten). `test/web-time.test.ts` locks the client
  wall-clock helpers, including the spring-forward gap (a typed time that
  doesn't exist falls forward) and the repeated fall-back hour.

## API surface

- `src/shared/validation.ts` + `src/worker/validators.ts` — every request
  body is Zod-validated; subtasks are exactly two levels deep (enforced in
  validators and routes).
- Ownership checks are always `WHERE user_id = ?`; foreign resources 404.
- State-changing requests are CSRF-guarded (origin check + token +
  `sec-fetch-site`).

## Security model

- **Password hashing**: PBKDF2 via `pbkdf2Chain` in `src/worker/auth.ts` —
  600,000 iterations in production, chained as 6 × 100k rounds because the
  Workers runtime caps a single `deriveBits` call at 100k. This matches the
  work factor of PBKDF2-600k but is a chained construction (see trade-offs).
- **Sessions**: opaque tokens, stored hashed, rotation on privilege changes,
  list + revoke in the panel; deactivation/password-reset revokes everything.
- **Rate limits**: bucketed (login per-IP/per-identifier, admin, token
  endpoints, heavy API, social actions, and **state-changing writes**). The hot
  per-user `api_user` counter lives in the user's UserHub DO (atomic); KV is
  the fallback and the counter for cold per-IP/per-email limits.
  `limitWrites` covers the CRUD/task/session/timer/group routes — previously they
  had _no_ rate limit, only eventual entity-count caps. It charges TWO budgets in
  one round trip: `write_user` (300/min) and `write_user_day` (20k/day), the
  latter being what actually bounds database work. Fan-out routes use
  `limitSocialWrites` (`social_write`, 60/min) instead, since one request there
  writes a `sync_log` row per group member. Per-user counters live in the
  UserHub's own storage, so they survive instance eviction — a 24-hour cap that
  resets when the DO is evicted is not a cap,
  so a leaked session could hammer `/timer/start`+`stop` freely. It is chained
  after `requireAuth` in each mutating route file's `use(...)` (and per-route for
  `misc.ts`'s settings/layout writes), skips GET/HEAD/OPTIONS (reads already ride
  `api_user`), and sets a per-request flag because two route files can match one
  path.
- **Accounts**: admin-managed — there is no self-signup (`/auth/signup`
  returns 404 and no UI exists). Login identifier is the `username` column;
  `users.email` is only an optional reset-mail address. The seeded `admin`
  credential (`changemeasap`) is public knowledge; the daily cron runs a real
  `verifyPassword` against it and logs `SECURITY_admin_default_password`
  while it still works, so "nobody rotated it" is visible in the logs
  (audit #4). Rotate it on every deploy — see [deployment](deployment.md).
- **Reserved schema**: `oauth_accounts` and `users.totp_secret` exist from
  `0001_init.sql` but nothing reads or writes them (only the account-delete
  cascade touches `oauth_accounts`). They are placeholders for FR-A3 (OAuth)
  and FR-A9 (TOTP), both unimplemented — see
  [requirement-coverage](requirement-coverage.md). Don't read them as
  evidence of a partially shipped feature.
- **Headers/CSP**: strict headers on every response; CSP carries
  `style-src 'unsafe-inline'` for React inline styles (documented trade-off).

## Social layer (friends → groups)

- Friend-visible projects require `visibility='friends' AND group_id IS NULL`
  — the two sharing mechanisms (friends ↔ groups) never cross.
- Group authorization lives in `src/worker/group-auth.ts` (`requireGroup` →
  404 for outsiders, `requireGroupPerm` → 403) over per-member permission
  flags (`GROUP_PERMS` in shared/constants, stored as JSON on
  `group_members.perms`); the owner implicitly has all permissions and is the
  only one who grants/revokes them.
- Group-project access resolution (`resolveProjectAccess` / `requireEditTasks`)
  lives in `src/worker/access.ts` — group **tasks** are shared (any member
  with `edit_tasks` edits), sessions stay strictly user-owned.
- Presence/chat never expose raw session rows or notes; reports are buckets
  only.
- Group-project/group-task deletes carry no undo payload across member
  boundaries; personal deletes keep the 5-second undo. Either way the delete is a
  **tombstone** (`deleted_at`), never a cascade: the row stays with its name, and
  so do the `time_sessions` that referenced it. `time_sessions.task_id … ON
DELETE CASCADE` meant one member deleting a shared task erased every OTHER
  member's history, which is the opposite of what a shared log is for.
  `access.ts` treats a tombstone as nonexistent for every live path; reports and
  the session log render it through `HISTORICAL_TASK_NAME` (the task's live
  name, else the `task_name` snapshot the session took at write time). A running
  timer on a tombstoned task is ENDED, not left running — the user can no longer
  see the task, and the single-timer invariant would otherwise block them from
  starting anything else. Undo and import clear `deleted_at`.
- **Group deletion** (owner-only) tombstones the group's tasks and detaches +
  tombstones its projects INSTEAD of letting `projects.group_id … ON DELETE
CASCADE` do the work — the old `DELETE FROM groups` cascaded every member's
  sessions on the group's tasks away (audit F2). Chat history is the one
  deliberate exception: `group_messages` dies with the group. `group.deleted`
  is emitted to the member list captured BEFORE the delete (the cascade empties
  `group_members`, so a post-delete lookup would notify nobody — audit F8).
- **Account deletion** (`DELETE /me`) resolves owned groups first, in the same
  atomic batch: a group with remaining active members is transferred to the
  earliest-joined one and the deleter's shared rows (projects, tasks, subtasks,
  dependencies — all carry a denormalized `user_id`) are reassigned to the new
  owner; a solo group is deleted exactly like the group-delete path above. The
  FKs with no `ON DELETE` action (`goals.user_id`, `group_invites.invited_by`,
  `group_invite_links.created_by`, `groups.owner_id`) get explicit deletes —
  without them the atomic batch 500'd and the account could never be deleted
  (audit F1). After the batch, the user's UserHub DO is wiped
  (`ctx.storage.deleteAll()` via the internal `/wipe` route) so pomodoro state
  doesn't outlive the account.

## Responsive & touch UI

The SPA adapts to three width tiers and two pointer classes; the tiers are
defined once in `styles.css` (header comment) and mirrored by `BREAKPOINTS`
in `src/web/lib/responsive.ts`:

- **< 640 px (phone)** — single column; modals render as full-screen sheets
  (`100dvh`); the session log renders as stacked cards instead of its 8-column
  table; the daily bar chart keeps a 520 px minimum width and scrolls inside
  its card; the topbar hides the account name.
- **640–1023 px (tablet)** — the project sidebar becomes an off-canvas drawer
  (hamburger + backdrop + close button).
- **≥ 1024 px (desktop)** — persistent sidebar, anchored popover menus.

Pointer classes (CSS media queries, no JS sniffing):

- `(pointer: coarse)` — touch-target scale: 40–44 px icon buttons/rows, 16 px
  inputs (prevents iOS focus zoom), keyboard-hint chips (`.kbd` in buttons)
  and view-tab shortcut hints hidden.
- `(hover: hover) and (pointer: fine)` — all `:hover` effects are gated here
  (no sticky hover on touch), and truncated text scrolls horizontally on hover.

Every interaction has a non-keyboard path:

- Sidebar project/task rows collapse secondary actions (color, reorder,
  visibility, archive, delete, rename) into a per-row **⋯ menu** on every
  screen. `RowMenu` portals outside the sidebar so anchored popovers are not
  clipped by its overflow; phones use a bottom sheet and other widths use a
  clamped popover. The timer stays inline. Rename is reachable without
  F2/double-click.
- The Map has zoom buttons and two-pointer pinch (capture-phase pointer
  tracking that cancels in-flight drags), plus a per-node **⋯ menu** so
  right-click/double-click are never required.
- The timer bar's idle copy switches between "press **T**…" and "tap ▶…" via
  `useHasHover()`.

Truncation policy: tight strips keep the one-line ellipsis; hover-capable
devices **auto-scroll the full text horizontally on hover** without changing row
layout; touch clamps `.row .grow` to two lines so truncation is visible; every
truncation site carries a `title` tooltip.

Mobile platform hygiene: `100dvh` app shell, `env(safe-area-inset-*)` padding
on the topbar/toasts/chat dock, `touch-action: manipulation` on controls
(the map canvas keeps `touch-action: none` for pan/wiring), toasts lift above
the chat launcher on phones.

## Project layout

```
migrations/0001_init.sql    D1 schema (numbered, additive)
src/shared/                 isomorphic code: ULID, timezone engine, validation
src/worker/index.ts         Worker entry: Hono app + UserHub DO + cron
src/worker/do/user-hub.ts   UserHub DO: WS hub, timer authority, pomodoro
src/worker/routes/          API route modules (one per domain)
src/web/                    React SPA: views/, components/, lib/
test/                       Vitest unit tests (DST fixtures, validators, …)
e2e/                        end-to-end verification scripts (see testing.md)
scripts/                    CI helpers (version check, e2e runner)
```

More detail on the trade-offs behind these decisions:
[requirement-coverage.md](requirement-coverage.md).
