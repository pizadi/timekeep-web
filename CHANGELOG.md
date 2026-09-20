# Changelog

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
