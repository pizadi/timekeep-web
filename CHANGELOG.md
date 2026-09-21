# Changelog

## 2026-09-21 — 0.2.0-dev.3: subtask attribution on sessions

A session can now record WHICH subtask it tracked (0..1 per session — NULL =
task-level time). Migration `0009_session_subtasks.sql` — run
`npm run db:migrate:local`.

- **Timer on a subtask.** `/timer/start` and `/timer/switch` accept an optional
  `subtask_id`; the UserHub DO validates it belongs to the task (422
  `invalid_subtask` otherwise), persists it in the session row + the
  `active_timers` recovery mirror, and carries it in the payloads. Switching
  subtask — same task or another — reuses the atomic switch: the segment stops
  with its subtask and a new one starts with the next (zero gap/overlap). A
  no-op switch (same task + subtask) returns the running session unchanged.
  The single-timer invariant is untouched.
- **Sidebar.** Every subtask row gains a ▶/■ timer button — start/switch/stop
  per subtask; the row highlights while its subtask is the one running.
- **Timer bar + tab tray** show `Task ▸ Subtask` while a subtask session runs.
- **Manual sessions + Log.** The session editor gains a subtask dropdown
  (filtered to the chosen task; resets when the task changes); log rows render
  `task ▸ subtask`; `PATCH /sessions/:id` can set or clear (`subtask_id: null`)
  the link. Cross-task links are rejected (422 `invalid_subtask`).
- **Reports.** `/reports/summary` table rows now carry a nested `subtasks`
  breakdown (per-subtask today/week/all) — sessions without a subtask stay on
  the task row, so task totals are identical to before. The dashboard table
  renders them indented. Charts remain project-level.
- **Deletes keep time.** Deleting a subtask (or its parent task/project via
  cascade) never destroys session rows — the link is `ON DELETE SET NULL`.
  Import/restore insert subtasks before sessions and drop dangling links
  instead of aborting the batch; imported rows validate the link against the
  task. Export carries `subtask_id` (SELECT *).
- Verified: dedicated e2e (`e2e/subtask-sessions.sh` — start/switch/split/
  manual/link-rejection/report/deletes) + the full social e2e.

## 2026-09-21 — 0.2.0.dev2: UI polish — graphical dropdowns, hover names, shortcuts, archive speed

- **All dropdowns are graphical** — the nine native `<select>` elements (settings: week start,
  theme, pomodoro auto-start; Log filters: project/task; Dashboard: range/sort; Map: project
  selector; group member role) are replaced by a custom listbox (`components/Dropdown.tsx`)
  that renders icons and project color chips, supports full keyboard navigation
  (↑/↓/Home/End, Enter, Esc) with `aria-expanded`/`role=listbox`/`aria-activedescendant`,
  closes on outside click, and never overflows its container.
- **Full task/subtask names on hover** — truncated names now show in full: sidebar subtask
  rows gained `title`s, Log table cells carry them, and Map nodes/subrows use SVG `<title>`
  tooltips.
- **New keyboard shortcuts** — <kbd>P</kbd> new project, <kbd>S</kbd> new subtask on the
  selected task (alongside N/T/F2/Delete); documented in the `?` shortcut overlay.
- **Archiving is fast** — two fixes: the PATCH path dropped two sequential D1 round trips
  (the access-resolution row is reused for the response; the event fan-out reuses the known
  `group_id` instead of re-reading), and the sidebar now applies the archived state
  **optimistically** (instant flip, revert + toast on failure).

## 2026-09-21 — 0.2.0.dev1: prompt dialog keyboard fixes

- **Enter-create no longer re-opens the dialog.** Closing a prompt by confirm
  (Enter or the primary button) restored focus to the trigger — the focused
  `＋ Project`/`＋ Task` button — so the very next Enter re-opened the dialog,
  which felt like "Enter never closes it". Confirms now move focus to the page;
  cancels (Escape/Cancel/overlay click) keep the standard focus restoration to
  the trigger.
- **`onDone` fires at most once** — a second Enter racing the modal's async
  unmount (or an overlay click + key in the same frame) can no longer
  double-resolve or re-open.
- **The a11y hook (`useModalA11y`) subscribes once** instead of tearing down and
  re-subscribing on every keystroke (the `onClose` callback identity changes
  with each character typed into a controlled input) — focus no longer thrashes
  while typing, and the Escape/Tab-trap listeners are stable.
- Regression coverage: `test/prompt-modal.test.ts` (jsdom) pins Enter-close,
  single-fire, the confirm/cancel focus semantics, and typed-confirmation
  gating.

## 2026-09-21 — v0.2.0: social layer (friends, groups, chat, group projects)

Five-phase social feature set on the same architecture (no new DO class —
cross-user fan-out rides the per-user UserHub + `sync_log` pipeline):

1. **Friends by username** — requests/accept/decline/cancel/unfriend, reverse-request
   auto-accept, existence-oracle-safe username lookups, new Social view (5th tab).
2. **Project visibility** — `projects.visibility` private|friends with a one-click sidebar
   toggle; friends browse shared projects read-only (structure + aggregate buckets + live
   "tracking now" presence via `friend.timer` events — never raw rows/notes).
3. **Groups** — membership with an owner/admin hierarchy, username invites, token invite
   links (SHA-256-hashed, single-reveal, expiry/use-caps/revocation), SPA `/join/:token` page.
4. **Fine-grained permissions** — six per-member capability flags (`GROUP_PERMS`) granted by
   the owner; 'admin' is a label, power is the flag set. Enforced in `worker/group-auth.ts`.
5. **Group chat** — live delivery over the social fan-out, cursor-paginated history, edit/
   soft-delete with moderation permission, unread badges via `last_read_at`.
6. **Group projects** — `projects.group_id` members-only projects shared into the sidebar;
   task edits gated by `edit_tasks`; simultaneous per-user tracking preserved; new cross-member
   group report (buckets only).

Migrations `0005`–`0008` (all additive). New e2e: `bash e2e/social-test.sh`.
Also fixed here (phase 1 commit): **project PATCH silently no-oped** — bind order was
swapped vs `WHERE id = ? AND user_id = ?`, so renames/recolors/archives reverted on refresh.

### Social phase 4: group projects (members-only)

Migration `0008_group_projects.sql` — run `npm run db:migrate:local`.

- **`projects.group_id`** (additive column, FK → groups ON DELETE CASCADE).
  NULL = personal project (unchanged semantics); set = the project belongs to
  the group and is visible/editable by every CURRENT member only. The row's
  `user_id` stays the creator for audit; tasks/subtasks/deps keep per-user
  attribution — sessions are still strictly yours, so the single-timer
  invariant (per-user partial unique index) and personal reports are untouched,
  and two members can track the same group task simultaneously.
- **Access enforcement centralized** in `worker/access.ts`
  (`resolveProjectAccess` / `resolveTaskAccess` / `requireEditTasks`):
  personal = owner-only as before; group = member read access, `edit_tasks`
  for task/subtask/dependency writes, `manage_projects` for
  rename/color/archive/delete. Bootstrap, project/task/subtask/dependency
  routes, manual session entry and the UserHub DO's timer task-check all widened
  to the membership scope — leaving (or being kicked from) a group revokes
  access immediately, and deleting a group cascades its projects.
- **Event fan-out follows the audience**: mutations inside a group project
  append one `project.*`/`task.*`/`subtask.*` event per member (`emitEntityEvents`)
  so every member's devices stay in sync; personal mutations are unchanged.
- **Group report**: `GET /api/groups/:id/report` aggregates ALL members'
  sessions on the group's projects into day × project buckets + per-member
  totals (viewer-timezone bucketing, running session clipped, buckets only —
  never raw rows).
- **Friend sharing excludes group projects** (`group_id IS NULL` in the
  friend-browsable queries) and `visibility` is rejected on group projects —
  the two sharing mechanisms can't be crossed.
- **No undo across member boundaries**: group-project and group-task deletions
  are permanent (typed confirmation); the event payload still carries every
  member's rows so all devices clean up.
- **UI**: the sidebar splits personal projects from a per-group "👥 group"
  section (group-colored); task/subtask edit affordances render only for
  members holding `edit_tasks`, project controls only for `manage_projects`;
  the group panel lists shared projects and creates new ones
  (`manage_projects`).

### Social phase 3: group chat

Migration `0007_chat.sql` — run `npm run db:migrate:local`.

- **Group chat.** `GET /api/groups/:id/messages` (member-only, cursor pagination
  over the ULID id — `?before=` + capped page size), `POST …/messages` (body ≤
  2,000 chars, `limitHeavy`-throttled), `PATCH …/messages/:id` (sender-only,
  `(edited)` marker), `DELETE` (sender or a member holding
  `moderate_messages`) — deletes are soft tombstones ("message removed").
- **Delivery reuses the social fan-out.** One `group.message_created/updated/
  deleted` sync_log row per member + a UserHub notify each, so live clients see
  messages in real time and offline clients catch up through the existing
  `/sync` reconcile poll. The acting device applies the API response (its own
  echo is ignored by the `actor === deviceId` guard). No DO state — D1 is the
  only authority; nothing is persisted per-keystroke.
- **Unread badges.** `group_members.last_read_at` vs message `created_at` —
  the group list carries an `unread` count (others' messages only); the open
  chat panel marks read via `POST …/read` (MAX-clamped) and the SPA patches its
  badge locally so a message never triggers a refetch.
- **UI.** Group detail gains a collapsible chat panel: history + "load older",
  live appends, edit/delete affordances gated by sender/`moderate_messages`,
  composer with Enter-to-send.
- Outsiders and former members get 404 on all chat reads (membership checked
  per request, never cached client-side).

### Social phase 2: groups, invites, fine-grained permissions

Migration `0006_groups.sql` — run `npm run db:migrate:local`.

### Groups

- **Group CRUD + membership.** `POST /api/groups` (creator becomes owner),
  `GET /api/groups` (mine + pending incoming invites), `GET /api/groups/:id`
  (members with roles/permissions), `PATCH` (rename/recolor), `DELETE`
  (owner-only, cascades members/invites/links), `POST …/leave` (owner must
  delete instead — 422), member kick via `DELETE …/members/:userId`.
- **Fine-grained permissions (feature 5).** Per-member capability flags stored
  on `group_members.perms` (JSON array of the `GROUP_PERMS` catalog in
  `shared/constants.ts`): `invite_members`, `remove_members`, `edit_group`,
  `manage_projects`, `moderate_messages`, `edit_tasks`. The owner implicitly
  holds all of them and is the only one who can grant/revoke (PATCH
  `…/members/:userId`); 'admin' vs 'member' is hierarchy/label — power lives in
  the flags. Enforcement is centralized in `worker/group-auth.ts`
  (`requireGroup` → 404 for outsiders, `requireGroupPerm` → 403 for members
  without the flag); the SPA member editor renders the checkbox matrix.
- **Username invites.** `POST /api/groups/:id/invites {username}` +
  accept/decline (invitee) + cancel. Duplicates of pending invites 409.
- **Invite links (token capability).** `POST /api/groups/:id/links` mints a
  256-bit token returned exactly once — only the SHA-256 hash is stored (same
  posture as auth sessions), with optional expiry + use cap + revocation.
  `POST /api/groups/join {token}` joins atomically (use-count increment and
  membership in one D1 batch; duplicate join rolls back); the SPA serves
  `/join/:token` with a preview-then-join page.
- **Event signals.** `group.created/updated/deleted`, `group.member_joined/
  left/removed/updated`, `group.invite_created/removed` append one sync_log row
  per current member (plus affected non-members) and fan out via their hubs —
  clients refetch the group lists on any `group.*` event. Bootstrap now carries
  `groups` + `group_invites`.
- **UI.** Social view gains a Friends/Groups section switch; group detail shows
  the member list (role badges, owner-only permission editor), invite
  management, link list with use counts, leave/delete with typed confirmation.
- **Limits.** ≤ 50 groups per user, ≤ 100 members per group, ≤ 20 active links
  per group; invites/joins/links share the `social_user` rate bucket.

### Social phase 1: friends + project visibility

New social layer, phase 1 of 5 (groups, chat, group projects and the
fine-grained permission matrix come next). Migration `0005_social_friends.sql` —
run `npm run db:migrate:local`.

### Friends

- **Friend requests by username.** `POST /api/friends/requests {username}`,
  accept/decline/cancel, unfriend. A reverse request auto-accepts. Deactivated
  accounts are invisible to the whole surface (lookups 404 the same as unknown
  usernames — no existence oracle); username lookups (`GET /api/users/lookup`)
  return `{id, username, name}` only.
- **Cross-user event fan-out.** `emitToUsers()` appends one `sync_log` row per
  recipient (per-user AUTOINCREMENT ids, so the existing `/sync` cursor logic is
  untouched) and notifies each recipient's UserHub. New events: `friend.requested`,
  `friend.accepted`, `friend.removed` — signal-only; clients refetch the small
  social lists. The acting user is included so their other devices converge.
- **New Social view** (5th tab, `/social`, shortcut `5`): add-by-username,
  incoming/outgoing requests, friend list with unfriend.

### Live presence + shared projects

- **`friend.timer` presence events.** Starting/stopping/switching a timer on a
  `friends`-visible project appends a small presence event to each friend's
  sync_log (only the tracker identity, project, task name and started_at —
  private projects emit nothing). Fan-out lives in the UserHub DO next to the
  timer state machine; best-effort, never surfaces errors to the tracker.
- **Project visibility.** `projects.visibility` (`private` | `friends`,
  default `private`), toggled from the sidebar (🔒/👀). Friends get read-only
  access: project structure + aggregate day buckets in the viewer's timezone +
  live "tracking now" status — never raw session rows or session notes
  (same posture as the reports surface: buckets, not rows).
- **Presence snapshot.** `POST /api/friends/presence` answers "which of these
  friends are tracking right now" via their UserHub `/state` (internal only),
  used once when the Social view mounts; live updates ride `friend.timer`.
- Bootstrap now carries `friends` / `incoming_requests` / `outgoing_requests`.

### Fixed

- **Project PATCH silently no-oped** (pre-existing): the bind order was swapped
  versus `WHERE id = ? AND user_id = ?`, so every project rename/recolor/
  archive/visibility update matched zero rows and the API echoed the unchanged
  row — changes reverted on the next refresh. Binds now match the SQL and a
  zero-change UPDATE returns 404 instead of a fake success.
- Friend-request ids are ULIDs (client-addressable entities follow the id
  convention; `ulidish` route validation now matches).

### Rate limits

- New `social_user` rule (default 30/h, `RL_SOCIAL_USER` override) buckets
  friend-request sends and username lookups together — covers request spam and
  cheap username enumeration.

## 2026-09-20 — v0.1.1: security & quality fixes from the audit

Findings, evidence and file references: `AUDIT.md`.

### Security

- **Revoked sessions now lose their live WebSockets.** Password change,
  single-session revoke, revoke-others and logout deleted the D1 session rows
  but never told the Durable Object, so a revoked device kept receiving sync
  events until its socket died naturally. Sockets are now tagged with their
  auth-session id at upgrade time and `/revoke` accepts `keep`/`only` filters
  (the acting device's socket survives a password change; everything else
  closes with code 4001).
- **The WebSocket upgrade path now applies the same gates as `requireAuth`** —
  a `must_change_password` account can no longer stream events over a socket
  while blocked everywhere else.
- **Import/restore are schema-validated row-by-row** (new per-row Zod schemas in
  `validators.ts`). This closes six holes: arbitrary non-ULID ids landing in the
  DB, 3-level task hierarchies, cross-project dependency edges, negative-duration
  restored sessions, NaN-bind 500s (garbage `position`/`created_at`), and
  client-controlled `created_at` (now clamped to `[0, now]`). Bad rows are
  skipped + counted on import; mutated undo payloads are rejected. Import and
  restore also enforce a request-size cap (413) — the row-count guards were
  unreachable for multi-MB bodies.
- **Rate limiting is atomic.** The KV read-modify-write counters (race-exceedable
  under concurrency) are replaced by a `rate_counters` D1 table written with a
  single atomic `INSERT … ON CONFLICT … RETURNING` (migration `0004`; pruned
  daily by cron). Confirmed: rotating `X-Forwarded-For` cannot defeat limits.
- **The DO's internal-only marker is actually checked now.** `x-internal: '1'`
  used to be sent by callers and verified by nothing; every UserHub route now
  requires it, and `/ratelimit` validates its inputs.
- **Device identifiers are sanitized** (charset + 64-char cap) before they are
  echoed into events and persisted in `sync_log`.

### Correctness

- **The 12-hour nudge no longer loops.** Once a timer passed 12h the DO re-armed
  an already-past alarm deadline, refiring the nudge (a D1 write + broadcast per
  tick) in a tight loop. The nudge now repeats hourly at most.
- **Layout changes and undos fan out to other devices** (`layout.updated` /
  `restore.completed` events) — both were silent before, leaving other devices
  stale until a reload. MapView refetches positions on `layout.updated`.
- **PUT /settings writes settings + profile theme mirror + event in one batch**;
  import does the same for its settings merge (crash consistency).
- **DO timer stop/switch get the same failure posture as start** (mirror-resync
  instead of a 500 / ghost state), and the break-end auto-start rolls the phase
  back to `ready` if the timer fails to start.
- **MapView starting a timer applies the `pomo` payload** (the MapView copy of
  the start/switch logic had dropped it, leaving pomodoro UI stale). The logic
  now lives once in `store.startTimer()`.
- **`GET /api/sessions` validates `from`/`to`/`cursor`** (422 instead of a
  silently-ignored or NaN filter), and reports reject ranges beyond 1500 days
  with a 422 instead of silently truncating.

### Web (SPA)

- **There is now a way to sign out** (Settings → Security → Sign out), a global
  401 handler (expired sessions return to login instead of toasting forever), a
  React error boundary (render errors show a reload screen instead of a
  white-screen), and Escape + focus traps on every modal.
- **PWA installability fixed:** real PNG icons (192/512 + maskable +
  `apple-touch-icon`), `theme_color` aligned with the app, service-worker cache
  versioned (`v2`).
- **Initial bundle halved** (441 KB → 229 KB, 143 → 71 KB gzip): chart.js moved
  to a lazy chunk loaded only on the Dashboard.
- Keyboard shortcuts no longer fire while a modal is open; pomodoro sliders
  persist for keyboard users; heatmap cells are keyboard-focusable; QuickFind
  and heatmap navigation keep the URL in sync; session fetches are
  race-guarded; the session editor no longer double-submits; the device id is
  per-browser (`localStorage`), not per-tab.
- Removed dead code: `limitProblem`, `nameProblem`, `findOverlaps`,
  `edgeProblem`, `subtaskPositionLimitProblem`, `optionalAuth`, `RATE_RULES`,
  the `signup_ip` rate rule, `wallClockMs`, `todayCivil`, `runningElapsedMs`,
  `tzOf`, `stopPolling`, dead re-exports/state/markup, and five dead CSS rules.
  `SESSION_SECRET` and `RL_SIGNUP_IP` removed from `.dev.vars` (both unused).
- Import throughput: ~3× faster (existence checks hoisted out of the per-chunk
  loop, chunk size 50 → 200); 20k sessions dropped from ~111 s to ~38 s.

## 2026-09-20 — v0.1.0: dialog overflow fix, styled comboboxes, pomodoro mode replaces the simple timer

### Web (SPA)

- **Manual session dialog no longer clips.** The Start/End fields sat in a
  `1fr 1fr` grid whose tracks honor the large intrinsic minimum width of
  `datetime-local` inputs — at the modal's 460px width the fields spilled past
  the dialog border. Inputs now get `min-width: 0`, the two-column grids use
  `minmax(0, 1fr)` tracks (Log editor + Settings), and `.modal` scrolls
  (`max-height: calc(100dvh - 32px)`) instead of overflowing on short viewports.
- **Suggestion pickers are custom comboboxes.** The unstyleable native
  `<datalist>` boxes (task picker in the session editor, timezone picker in
  Settings) were replaced by a shared `Combobox` component: themed dropdown with
  project color chips and grouped headers, full keyboard support
  (↑/↓/Enter/Esc/Tab), ARIA combobox/listbox semantics, and viewport-positioned
  rendering so modal scroll containers can never clip it. Save-time task
  resolution (exact → unique contains) is unchanged.
- **Pomodoro mode (opt-in) replaces the simple timer.** Settings → Pomodoro has
  an enable toggle; when on, every plain timer start (T key, Jump back in,
  timer bar) runs the pomodoro state machine — focus block, "goal reached"
  decide prompt, timed break, ready — instead of a bare timer. The timer bar
  shows the phase ring and its controls for every timer, and the idle hint
  names focus blocks. Turning the mode on requests notification permission
  immediately (user gesture); end-of-run events (focus goal reached, break
  over) always fire a browser notification when permission was granted plus the
  in-app toast; other phase changes keep following the "Browser notifications"
  toggle. Sound still follows the sound setting.

### Worker / Durable Object

- **`pomodoro.enabled` setting (default false).** Added to the settings schema
  and defaults; no migration (settings are a merged JSON blob). The UserHub DO
  picks the flag up live via `settings.updated`; disabling mid-cycle cancels the
  live pomodoro everywhere (broadcast `pomodoro.phase` idle) while the running
  timer keeps counting — nothing ever auto-stops.
- **Plain timer starts engage the focus cycle when the mode is on.** `/timer/start`
  seeds a fresh focus phase (idle/decide/ready → focus; starting during a break
  cancels the break — same semantics as `/pomo/start`), and the session row is
  written with `source: 'pomodoro'` so the log's Source badge is meaningful;
  `/timer/switch` re-anchors the running cycle to the new task and tags the new
  session `'pomodoro'` too. With the mode off, behavior and sources are
  unchanged. `timer/start` and `timer/switch` responses now carry the
  DO's `pomo` state (acting devices apply it directly — they ignore their own
  WS echoes).
- **Ring correctness while the timer is stopped.** Focus accumulation freezes
  when tracking stops (FR-F1); the client no longer advances the frozen
  `focus_ms_live` snapshot (break countdowns still tick against the
  wall-clock deadline).

### Tooling

- **Versioning.** `0.1.0` is the first tagged release. The app semver lives in
  `package.json` and is injected at build time: the SPA gets it via the Vite
  `define` (shown as "TimeKeep v0.1.0" at the bottom of Settings), the Worker
  via the `__APP_VERSION__` define in the wrangler configs (bump together with
  `package.json` on release). `GET /api/version` now reports `version` (semver)
  alongside `build` (deploy SHA); the SPA bundle embeds the same version.

### Tests

- New `e2e/pomo-mode-test.mjs`: mode off → plain starts (`source: 'timer'`),
  mode on → engaged focus cycle + sources, switch re-anchoring, skip → idle,
  disable mid-cycle → idle + timer keeps running, legacy `/pomo/start` intact.

## 2026-09-17 — Correctness, sync, and UX fixes across worker, DO, and SPA

A broad fix pass over the whole codebase. Detailed notes:

### Worker / Durable Object

- **Settings reach the timer authority.** The UserHub DO read persisted settings
  keyed by its own internal hex id instead of the real user id, so user-configured
  pomodoro durations were silently ignored and defaults always applied. The lookup
  now uses the real user id, and `settings.updated` events live-invalidate the DO's
  in-memory settings so changes propagate to a running DO.
- **No more ghost timer after task/project delete.** Deleting the task or project a
  timer was running on cascade-deleted the session rows but left the DO's in-memory
  running state behind, so every later timer start 409'd against a session that no
  longer existed. The DO now clears running/pomodoro state when delete events
  reference the tracked task, broadcasts a synthetic `timer.stopped`, and clients
  drop the stranded timer too.
- **Timer start ordering.** The DO previously set its in-memory running session
  *before* the D1 batch; a batch failure left it holding state for a session that
  was never written. In-memory state now advances only after D1 confirms, and a
  batch failure resyncs from the recovery mirror (409 if something else is running,
  503 otherwise) instead of surfacing a raw 500.
- **Pomodoro survives DO eviction.** The persisted `lastResumeMs` is honored on
  rehydration instead of being reset to "now", which discarded the entire in-flight
  focus segment and extended the phase goal after every restart. Restarting a focus
  phase that is already live is now idempotent rather than discarding accumulated
  time. `userId()` fails loudly if the DO was not constructed via `idFromName`
  instead of silently deriving a wrong id.
- **Daily backups are complete and loud.** The R2 dump's keyset pagination compared
  `user_id > 'user\0id'` — a prefixed string against its own prefix — which
  silently skipped every remaining row of each page's last user, truncating any
  table larger than one page. Dumps now page on the `(user_id, id)` tuple, stream
  to R2 via multipart upload (memory bounded by one page, not the whole dump), and
  abort loudly on read errors instead of treating them as end-of-table.
- **Cron garbage-collects.** Expired auth sessions and email tokens were only
  removed when presented again; the daily cron now prunes both so the tables don't
  grow monotonically.
- **Rate limiting.** The hot per-user `api_user` counter moved into the UserHub DO
  (single instance per user → atomic read-modify-write, no ~2 writes/s on a single
  KV key, which exceeded KV's per-key write ceiling and could 500 under sustained
  load); KV remains the fallback and the counter for cold per-IP/per-email limits.
  Fan-out notifies are registered via `ctx.waitUntil` so they survive the response.
  Unauthenticated token endpoints (`/auth/verify-email`, `/auth/reset-confirm`) and
  admin mutations (a full PBKDF2 per call) are now rate limited; `clientIp` falls
  back to `x-forwarded-for` so local dev doesn't share one lockout bucket.
- **Sessions middleware.** The per-minute heartbeat no longer rewrites a dead
  "sliding window" value (the math always produced the old expiry); renewal is
  token rotation in the final 7 days, as before. The double-submit CSRF cookie is
  re-issued when lost (browser restart with a persisted session cookie) so the
  second defense layer resumes.
- **Export/import/restore.** CSV export resolves projects via O(1) map lookups
  instead of an O(sessions × tasks) `.find()` that blew Worker CPU budgets. Project
  and task deletes read the undo payload and delete in one transactional batch with
  scoped SQL (no whole-table loads filtered in JS, no race dropping rows from the
  payload). Layout and reorder statements are chunked at 50 like import. Import now
  enforces the same DAG-cycle, session-sanity, and entity-limit rules as the CRUD
  routes (a hand-edited file could previously corrupt the DAG or land sessions at
  epoch-1970), reports accurate created/updated/skipped counts, applies imported
  settings, and emits an `import.completed` event so other devices refetch.
  `/restore` verifies dependency ownership (foreign task ids were accepted) and runs
  in chunked batches instead of one round-trip per row, which could outlast the
  5-second undo window.
- **Smaller worker fixes.** WS upgrade check is case-insensitive per HTTP; the ULID
  same-millisecond increment carries correctly and can no longer emit malformed ids;
  `verifyPassword` tolerates malformed stored hashes instead of crashing; unique-
  constraint detection is centralized in one helper; the chained-PBKDF2
  construction is documented honestly (work-factor-equivalent, not literal
  PBKDF2-600k); duplicate `/api/version` registration and the declared-but-never-
  read `SESSION_SECRET` removed; middleware/route contexts typed instead of `any`.
- **Verification resend.** New `POST /auth/resend-verification` endpoint backs the
  app's verification banner (it previously posted to `/auth/reset-request`, i.e.
  requested a password reset for the user's own address). Reset responses never
  carry live token links, even under `EMAIL_DEV_MODE` — the dev console log is the
  dev surface.

### SPA

- **Password reset and verification are reachable.** New `/reset?token=…` and
  `/verify?token=…` views — the emailed links previously landed on the login form
  with no way to enter a new password, making the backend flows unreachable.
- **Mobile layout works.** The hamburger button was hardcoded `display:none`, so
  the off-canvas sidebar (the primary navigation) could never be opened on
  phones/tablets. It is now visible below 1024px.
- **Dashboard numbers are correct and live.** Server aggregates already include the
  running session clipped to the fetch instant; the client added the *full* elapsed
  on top, double-counting it, and the value never re-computed between fetches. Only
  the post-fetch tail is added now, ticked every 30 s. The pomodoro ring and break
  countdown advance live from event snapshots (server-clock corrected) instead of
  freezing for the whole phase.
- **Sync recovers.** One failed WS connect permanently latched the client onto
  30-second polling for the session. The socket is now retried with backoff
  indefinitely, a reconcile poll runs alongside the socket (and drains sync
  backlogs past the 500-event page), and the tab re-polls when it becomes visible.
- **Log view.** Manual sessions always save a closed interval against an explicitly
  resolved task (stale selections and free text that matches nothing are errors, not
  silent wrong-task saves); note search is debounced; date filters use the shared
  day engine (DST-correct on 23/25-hour days); the heatmap day click now drives the
  log filters; LIKE wildcards are escaped server-side; the recovery prompt is
  reachable after loading with a timer already running, and its Discard action stops
  the timer and opens the editor prefilled with the configured grace.
- **Editing UX.** Escape cancels in-place renames (it previously committed via
  blur); blocking `window.prompt` dialogs replaced with a non-blocking modal
  component; pomodoro notifications fire once per phase change.
- **Routing/discoverability.** Views are URL routes (`/`, `/log`, `/map`,
  `/dashboard`) with back/forward support; view tabs are visible on desktop;
  "Jump back in" is ordered by last tracked activity rather than position.
- **Hygiene.** CSRF cookie re-issued when lost; moving a task into an archived
  project blocked (parity with creation); stale frontend types updated
  (`week_start` 0–6); ignored `applyTheme` prop, duplicate `fmtHMS`, hidden-span
  re-render hacks, dead assignments, and the unused `restoreMaxRows` constant
  (now used as the restore total-row guard) cleaned up.

### Tests & docs

- 43 unit tests: ULID monotonicity/carry, cron keyset shape, manual-session schema
  rejections, restore payload caps, DST-correct day bounds.
- `e2e/regression-check.mjs`: targeted API probes for the behaviors above (rejected
  open-ended sessions, no ghost timers, no token links in responses, resend
  endpoint, token-endpoint 429s, import enforcement, cross-user restore rejection).
- README, AGENTS.md, and `docs/requirement-coverage.md` reconciled with actual
  behavior (same-batch event claim, reset UI, `lib/ws.ts` reference, secret list,
  documented trade-offs).
