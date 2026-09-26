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

| Store | Used for |
|---|---|
| **D1** (SQLite) | all durable entities: users, sessions, projects, tasks, subtasks, dependencies, `time_sessions`, `sync_log`, email tokens, groups, chat, rate counters |
| **KV** | cold rate-limit counters (per-IP / per-email buckets), misc cache |
| **UserHub DO** (`src/worker/do/user-hub.ts`) | one DO instance per user: WebSocket hub, timer authority, pomodoro state machine, the hot per-user API rate counter |

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
- **Transactionality**: the UserHub DO writes entity rows and events in ONE D1
  batch; route handlers use two back-to-back batches (entity write, then
  events). A crash between the two can drop the event — clients recover via
  the reconcile poll / refetch.
- Cross-user fan-out (friends, groups) uses `emitToUsers`: ONE sync_log row
  per recipient + a notify of each recipient's UserHub.
- **Recency** ("Jump back in" / Resume): `GET /api/bootstrap` returns
  `recent: [{ task_id, subtask_id }]` — one entry per task, newest first,
  carrying the subtask of that task's most recent session (a window function,
  not a `GROUP BY`, which would drop the column). The client keeps the pair in
  `recentEntries` (`src/web/lib/recent.ts`, pure + unit-tested), so Resume,
  the `R` shortcut and the "Jump back in" chips all restart the *subtask* that
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
  endpoints, heavy API, social actions). The hot per-user `api_user` counter
  lives in the user's UserHub DO (atomic); KV is the fallback and the counter
  for cold per-IP/per-email limits.
- **Accounts**: admin-managed — there is no self-signup (`/auth/signup`
  returns 404 and no UI exists). Login identifier is the `username` column;
  `users.email` is only an optional reset-mail address.
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
- Group-project/group-task deletes are permanent (no undo payload across
  member boundaries); personal deletes keep the 5-second undo.

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
