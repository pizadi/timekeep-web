# TimeKeep Web — Audit Report

**Date:** 2026-09-20 · **Scope:** full repo at commit-time state · **Mode:** report-only (no code changed)

**Method.** Static: line-by-line review of the worker (routes, middleware, DO, cron), shared code, and the SPA, with every claim cross-referenced by grep. Dynamic: a purpose-built probe suite against local `wrangler dev` (unauth matrix, import/restore abuse, WS-lifecycle, rate-limit behavior, CSV injection), the full e2e suite (`smoke-test.sh`, `ws-test`, `undo-test`, `pomo-mode-test`, `regression-check`, `roundtrip-test` — all passing), and a seeded performance run (100 projects / 3 000 tasks / 20 000 sessions). Baseline: `typecheck` ✅, 43/43 unit tests ✅, build ✅ (441 KB JS / 143 KB gzip).

**Evidence tags:** `[dynamic]` = reproduced against the running app · `[code]` = static analysis with file:line. Severity: 🔴 High · 🟠 Medium · 🟡 Low.

---

## 1. Security issues

> Overall posture is **good**: consistent `user_id` scoping in every query, Zod on (most) bodies, CSRF defense-in-depth, hashed opaque session tokens, no token/secret leakage in logs, CSV formula-injection guard that works `[dynamic]`. The findings below are the exceptions — the WS lifecycle and the import/restore path are the two weak fronts.

### 🔴 S1 — Revoked sessions keep live WebSockets
- **Where:** `src/worker/routes/me.ts:65-86` (password change), `me.ts:129-134` (revoke one session), `me.ts:136-139` (revoke-others). All delete D1 session rows but **never call `revokeHub()`** — unlike admin reset (`admin.ts:116`), reset-confirm (`auth.ts:198`), deactivation (`admin.ts:87`) and account deletion (`me.ts:114`), which do.
- **Proof `[dynamic]`:** device B opened a WS; device A changed the password; B's socket kept receiving `timer.started`/`timer.stopped` events while B's HTTP returned 401.
- **Impact:** "sign out all other devices" (and the revocation that follows a password change) does not actually cut off a stolen/latched device until its socket dies naturally — it keeps streaming every mutation.
- **Fix:** call `revokeHub()` in all three places (one line each, pattern already exists).

### 🔴 S2 — WebSocket upgrade skips the forced-password-change gate
- **Where:** `src/worker/index.ts:42-72` — the WS path re-verifies the session but not `must_change_password` (nor `active`, though deactivation deletes sessions so that part is mitigated).
- **Proof `[dynamic]`:** a fresh admin-created user (`must_change_password=1`) is 403-blocked on `/api/bootstrap` but successfully upgrades `/api/ws`.
- **Impact:** breaks the documented gate invariant (AGENTS.md: "blocks every endpoint except…"). The user only streams their own data, but the gate is the product's answer to "admin-set password must be rotated" — WS is a hole in it.
- **Fix:** apply the same check on the upgrade path (or inside the DO on connect).

### 🔴 S3 — Import/restore bypass the data invariants (`z.array(z.any())`)
- **Where:** `src/worker/validators.ts:126-137` (`importSchema`) and `:145-157` (`restoreSchema`) validate all five collections as `z.any()`; real validation is ad-hoc per-row coercion in `src/worker/routes/export.ts`. Confirmed abuses (all `[dynamic]`, merge-mode import by the owning user):
  1. **Arbitrary non-ULID ids land in the DB** — task `id: "X53430WEIRD…"` inserted with a real `user_id` (`export.ts:148-149` passes ids through raw; `:252` binds `parent_id` raw). Breaks ULID-ordering assumptions, sync payloads, and any future code trusting id shape.
  2. **3-level task hierarchy created** (violates the enforced two-level rule, FR-T3) — no parent-is-root check on import (`export.ts:232-257`).
  3. **Cross-project dependency edge created** (violates FR-M5, which `rules.ts` enforces on the API path) — `export.ts:186-208` cycle-checks but never checks same-project.
  4. **Negative-duration session restored** — undo payload mutated to `ended_at < started_at` and `/restore` accepted it (`export.ts:443-445` lacks the `ended <= started` check the import path has at `:307`). `[dynamic]` restored a −5 000 ms session.
  5. **NaN positions → unhandled 500** — `Number(p.position ?? 0)` on a non-numeric string (`export.ts:226-227,254,276`) → `NaN`, which D1 binds as SQL NULL → `NOT NULL constraint failed: tasks.position` → unhandled 500 instead of 422 (same for garbage `created_at`).
  6. **Client-supplied `created_at` accepted** on new rows (`created_at: 12345` landed) — mass assignment of audit fields.
- **Not vulnerable (checked):** cross-user leakage — upserts carry `WHERE … user_id = excluded.user_id` guards and restore requires both dependency endpoints owned; cross-user restore was rejected `[dynamic]`, matching `regression-check.mjs`.
- **Fix:** give import/restore real Zod row schemas (the shape is known — it's the export format), enforce the same hierarchy/dependency/duration/id-format rules the CRUD routes enforce, and 422 instead of 500 on coercion failures.

### 🟠 S4 — Rate-limit mechanics: non-atomic counters + login-lockout DoS
- **Where:** `src/worker/middleware.ts:254-261` — KV `get`→increment→`put` is a non-atomic read-modify-write; concurrent requests can each read the same counter and blow past the limit. On the login path this widens brute-force headroom.
- Also: the `loginEmail` rule (`:241`) counts **all** attempts (not just failures) keyed by identifier — anyone who knows a username can lock that user out for 15 minutes by sending 10 requests. Standard trade-off, but worth considering IP-only limiting on failures or progressive delay.
- **Note:** the KV fallback for `limitHeavy` is atomic-enough in practice because the DO path (`:279-296`) handles it per-user; the KV *login* path has no such serialization.
- **Fix:** move login counters into per-user/per-IP fixed-window DO counters (pattern already exists at `user-hub.ts` `/ratelimit`), or accept and document the race.

### 🟠 S5 — Decorative internal-only marker on the DO
- **Where:** callers send `x-internal: '1'` (`misc.ts:41,165`, `timer.ts:22-25`) but `src/worker/do/user-hub.ts` never checks it — its routes (`/notify`, `/ratelimit`, `/timer`, `/pomo`, `/state`, `/revoke`) do no auth at all (`user-hub.ts:140-201`). Safe today because DOs are only reachable from this Worker, but the header is cargo cult: it suggests a check that doesn't exist. `/ratelimit` also accepts arbitrary `limit`/`windowMs` (`user-hub.ts:188-191`).
- **Fix:** either check the header (defense in depth against future wiring mistakes) or delete it.

### 🟡 S6 — Smaller items
- **Unvalidated device identifiers** — `x-device-id` (`middleware.ts:149`) and the WS `?device=` param (`index.ts:67`) are free-form strings echoed into every broadcast event and persisted in `sync_log`; an unbounded 10 KB device id lands in every event payload. Cap/validate (e.g. ≤64 chars).
- **Hardcoded cookie name** — `index.ts:58` regex-matches `'tk_session'` instead of using `SESSION_COOKIE` (`constants.ts:32`); renaming the cookie would silently break WS auth while everything else kept working.
- **Session-rotation race** — `rotateIfNeeded` (`middleware.ts:76-96`): concurrent requests near expiry each mint a rotation; the loser's fresh session is deleted mid-flight → rare forced re-login. Acceptable; document or serialize per user.
- **Signup rate-limit rule guards a static 404** — `signupIp` (`middleware.ts:242`) + `RL_SIGNUP_IP` (`env.ts:19`) protect `auth.ts:24`, which returns a constant 404. Dead rule.
- **`/api/version` discloses build SHA** — trivial fingerprinting surface (`index.ts:32-37`); fine for an internal tool, worth knowing.
- **CSP `style-src 'unsafe-inline'`** (`middleware.ts:22`) — documented trade-off for inline style attributes; accurate, but revisit if the stylesheet grows.
- **XFF fallback in `clientIp`** (`middleware.ts:111-116`) — **not** exploitable in practice: Cloudflare (and even local `wrangler dev`) always provides `cf-connecting-ip`; rotating `X-Forwarded-For` failed to defeat limits `[dynamic]`. Only reachable if the app is ever hosted behind a non-CF proxy.

---

## 2. Dead / unusable code

Everything below is grep-verified (definition + zero production references). "Safe" = deletable without a migration.

### Worker
| Item | Location | Status |
|---|---|---|
| `limitProblem()` | `shared/validation.ts:126-128` | Dead, safe |
| `nameProblem()` | `shared/validation.ts:19-24` | Dead + a dead import at `routes/sessions.ts:8` |
| `findOverlaps()`, `edgeProblem()`, `subtaskPositionLimitProblem()` | `shared/validation.ts:72-87,122-124` | Test-only — production uses the `rules.ts` twins; the "shared contract" is one-sided |
| `optionalAuth` | `middleware.ts:172-183` | Imported (`index.ts:6`), never invoked — its comment about `/bootstrap` is stale |
| `RATE_RULES` | `middleware.ts:251` | Never imported |
| `signupIp` rule + `RL_SIGNUP_IP` env var | `middleware.ts:242`, `env.ts:19` | Guards a static-404 route |
| `wallClockMs()`, `todayCivil()` | `shared/time.ts:60-63,125-127` | Dead |
| `bucketByDay()` | `shared/time.ts:146-159` | Test-only reference impl (intentional, but prod-unused) |
| `WsEvent` re-export | `env.ts:64` | No consumer imports it from `env` |
| `users.totp_secret` column | `migrations/0001_init.sql:14` | No code reads/writes it (2FA is absent — see §4) — needs a migration to remove, or build the feature |
| `oauth_accounts` table + `purpose='magic'` token type | `migrations/0001_init.sql:19-24,41` | No OAuth or magic-link flow exists anywhere |
| Hardcoded `'tk_session'` | `worker/index.ts:58` | Not dead, but duplicates `SESSION_COOKIE` — drift risk |
| `SESSION_SECRET` in `.dev.vars` | repo-local config | Unused; `env.ts:26` documents the variable intentionally doesn't exist |

### Web
| Item | Location | Status |
|---|---|---|
| `runningElapsedMs()`, `tzOf()` | `lib/time.ts:59,94` | Dead |
| `stopPolling()` | `lib/store.ts:443-446` | Never called — notably, polling can never be stopped once started |
| `export { ApiError, nowMs }` | `components/TimerBar.tsx:280` | Dead re-export; `RecoveryPrompt` export likewise unneeded |
| `pomoVisible`, `const s = settings` | `App.tsx:88-89` | Computed, never used |
| `AppState.devices` | `lib/store.ts:56` (written ×3) | No UI reads it — a connected-devices feature with no surface |
| `<input type="hidden" value={turnstileToken} readOnly />` | `views/AuthView.tsx:48` | Dead markup; token travels via props |
| Dead CSS | `styles.css`: `.ok-text` (:260), `.sr-only-row` (:308), `.map-svg.panning` (:208), `.map-edge.hl` (:218), `--grid` var (:29,:47) | No TSX references |

No unused npm dependencies (chart.js is used by `DashboardView`; no console.log leftovers; no commented-out blocks anywhere — the codebase is clean in this regard).

---

## 3. Slop — code that isn't pulling its weight

Ranked by how much it costs maintenance vs. what it gives the user.

1. **Triplicated timer start→switch logic, one copy broken.** `TreeSidebar.toggleTimer` (`TreeSidebar.tsx:94-113`), `App.tsx` `QuickStart`+`switchTo` (`App.tsx:189-235`), and `MapView.toggleTrack` (`MapView.tsx:179-195`) all re-implement start → `already_running` → switch. The MapView copy **drops the `pomo` payload** from `/timer/start` and `/timer/switch` — starting a pomodoro from the dependency map leaves pomo UI state stale until the next WS echo, violating the documented AGENTS.md invariant. This should be one `store.startOrSwitch(taskId)` helper. *(The single highest-value fix in this section — it's a real user-facing bug, not just duplication.)*
2. **`SettingsView.tsx` — a 370-line modal doing six jobs** (profile, timezone/theme, pomodoro, notifications, session security, full admin user management, export, account deletion) with all state in one component. The admin panel especially should be its own surface.
3. **`export.ts` import path — a ~230-line copy-paste monolith** (per-collection chunk→existingIds→map→batch loops with subtly different filters). This is the *root cause* of every S3 finding. One generic per-entity importer would delete ~150 lines and the invariant holes with them.
4. **The web app never imports `src/shared/constants.ts`** — limits and defaults are re-hardcoded in 6+ places: grace `15` (`TimerBar.tsx:82,205`), pomodoro bounds `5–90`/`1–30` (`SettingsView.tsx:210,215`), page size `200` (`LogView.tsx:2`), `SYNC_PAGE=500` (`store.ts:448`), min-password `10` (three views), the 12-hour nudge string (`store.ts:185`). Server and client will drift.
5. **~25 copies of `try { api(…) } catch (e) { pushToast('error', e.message) }`** across views, with no shared `mutate()` wrapper and no busy/disabled states (double-click on ▶ or Save double-fires — `SessionEditor.save` has no guard, `LogView.tsx:253-285`).
6. **`TreeMain` (the default landing view) is a static instruction card** (`App.tsx:169-187`) — the app opens on a placeholder; all real task UI lives in the 290 px sidebar.
7. **1 Hz module-scope interval pumps the global store even on the login screen** (`main.tsx:19`), and `TimerBar` tears down/recreates its own interval every second because its effect deps include the value the interval updates (`TimerBar.tsx:22-28`).
8. **Smaller oddities:** batch-of-one `DB.batch` ceremony (`user-hub.ts:481-492,559-567`); `` placeholder={`Type DELETE to confirm`} `` — a template literal with nothing to interpolate (`SettingsView.tsx:339`); untyped `function LoginForm({ … }: any)` in an otherwise typed codebase (`AuthView.tsx:56`); `hello` handled twice in the same frame (`store.ts:175` + `:399-401`); hand-rolled error JSON duplicating `jsonError` (`sessions.ts:91-93`, `reports.ts:112`); lowercase error string inconsistent with all others (`ChangePasswordView.tsx:17`).

---

## 4. Feature gaps

### Bugs-of-absence (basic things the app genuinely lacks)
1. **No way to log out.** The only "Sign out" link is on the forced-password-change screen (`ChangePasswordView.tsx:55`); Settings can revoke every device *except* the current one (`SettingsView.tsx:253`). A signed-in user cannot end their session. `[dynamic]` — grep + full walkthrough found no other path. This is arguably a bug, not a gap.
2. **No React error boundary anywhere** — any render exception white-screens the SPA.
3. **No global 401 handling** — when a session expires, the poller just sets `connection='offline'` (`store.ts:469-471`) and every mutation becomes an endless stream of error toasts; the app never returns to login.
4. **No offline story beyond a banner** — no mutation queue/retry; failures are one-shot toasts.
5. **No import dry-run or per-row error reporting** — aggregate created/updated/skipped counts only (`export.ts:139`); a skipped row gives no reason.
6. **Undo covers deletes only** — edits, moves, and project archive are un-undoable.
7. **Accessibility:** no focus trap or Escape handling in any modal (Settings, SessionEditor, PromptModal, HelpOverlay); pomodoro sliders persist on `onMouseUp/onTouchEnd` only — keyboard users change values that never save (`SettingsView.tsx:210-218`); heatmap cells are click-only; QuickFind results lack listbox semantics (the `Combobox` next door does this right — the pattern exists in-repo).
8. **No list virtualization** — LogView accumulates every loaded page as DOM rows (200/page, unbounded) and any `reportsVersion` bump silently resets pagination; MapView renders all project tasks as SVG nodes (cap 5 000).
9. **No pagination on `GET /me/sessions` or `GET /admin/users`** (`me.ts:118-127`, `admin.ts:28-36`).
10. **PWA is half-real:** only icon is `favicon.svg` with `sizes: "any"` — Chromium install criteria want a ≥144 px PNG, and `apple-touch-icon` must be PNG on iOS (SVG is ignored) → the README's "PWA-installable" claim likely fails on both engines. `theme_color` (#4f8cff) disagrees with both HTML metas (#0f1420/#f4f5f7); SW cache name is a hardcoded `v1`.
11. **Keyboard shortcuts don't fire while a modal is open** (`App.tsx:68-86` has no modal guard) and `Delete` only removes tasks, never the selected project.
12. **URL/view desync** — `Heatmap.tsx:70` and `QuickFind.tsx:37` change views without URL sync; back/forward then misbehaves.
13. **Export is fully buffered** (`export.ts:29-31`, documented) — 20 k sessions = 5.6 MB JSON in memory `[dynamic]`; at the 200 k cap ≈ 56 MB inside a 128 MB isolate. Streaming is the fix.

### Recommended features for a timekeeping app (absent today)
Prioritized by expected user value; the stack supports all of them.

| # | Feature | Why / notes |
|---|---|---|
| 1 | **Calendar view** (day/week grid, sessions as draggable blocks) | The single biggest UX hole vs. Toggl/Clockify/TimeChamp; a Log *table* is not a calendar. Sessions are epoch-ms — rendering is straightforward. |
| 2 | **Billable rates & earnings** (per-project hourly rate → amounts in reports + CSV) | The killer feature for freelancers; pure arithmetic over existing reports buckets + a `rate` column. |
| 3 | **Favorites / recent tasks for one-click start** | Today starting a timer means a full Combobox drill; "last 5 tasks" chips on the TimerBar would remove the #1 daily friction. |
| 4 | **Weekly goal + progress ring** (e.g. 40 h) | All data exists in reports; one ring component. Pairs with the existing heatmap. |
| 5 | **2FA (TOTP)** | The `totp_secret` column already exists (§2) — the schema anticipated it; Workers can compute TOTP via WebCrypto. |
| 6 | **Tags on sessions** (orthogonal to project/task) | Standard for cross-project reporting; needs one table + report grouping mode. |
| 7 | **Idle detection / "still tracking?" prompt** | Desktop TimeKeep parity; JS visibility + no-input heuristics are enough for a PWA. The 12 h nudge exists but is 72× too coarse. |
| 8 | **Report time rounding & minimum-duration rules** | Required for anyone who bills from the CSV. |
| 9 | **Reports: week/month grouping toggle, period comparison, report CSV export** | Reports currently return day buckets + donut + table only; CSV of *sessions* exists but not of *aggregates*. |
| 10 | **Session tools: split, merge, bulk-edit; edit running note without stopping** | Small API additions on existing rows; big power-user win. |
| 11 | **Task due dates + overdue indicator** | Tasks have done/position/notes only; dates unlock planning use-cases. |
| 12 | **Project budgets (hours, with warning)** | Cheap: aggregate + threshold check + existing notification system. |
| 13 | **API tokens** | Cookie-only auth blocks scripting/CLI integrations; hashed tokens table already exists as a pattern (`auth_sessions`). |
| 14 | **Weekly email digest** | Resend adapter already exists (`auth.ts:100-115`); cron already runs daily. |
| 15 | **Admin usage stats / activity viewer** | `sync_log` holds the data; the admin panel shows users only. |

---

## 5. Bad implementation / design choices

1. **12-hour nudge alarm loop** — `src/worker/do/user-hub.ts:505-557`: once `now >= started_at + TWELVE_H`, `rearmAlarm()` computes a deadline already in the past and `setAlarm(past)` fires immediately → `alarm()` logs `timer.nudge` to `sync_log` + broadcasts → re-arms the same past deadline → **unbounded D1-write loop** until the user stops the timer. Fix: after firing the nudge, clamp the next alarm to `now + n` or track "nudge fired" per threshold crossing.
2. **Import/restore as ad-hoc coercion instead of the Zod layer that exists** — see S3; the design choice (validators.ts declares shapes, export.ts ignores them) is the finding.
3. **Sync surface is inconsistent** — `[dynamic]`: **layout PUT emits no sync event** and **restore emits no sync event**, while every other mutation fans out. Other devices silently keep stale map positions and deleted (then restored) tasks until a full refresh. Either emit events or document the exclusion; right now it just breaks the "multi-device live sync" promise for those actions.
4. **Settings write is 3 unrelated round-trips** (`misc.ts:97-107`: settings UPDATE, users.theme mirror, event append) while delete paths batch properly — a crash between them leaves theme/settings/event divergent. Also `mergeSettings` is duplicated (`export.ts:329-349` vs `misc.ts:87-94`) with *different* theme-mirroring behavior (import doesn't mirror).
5. **DO error-handling asymmetry** — `timerStart` wraps its batch with mirror-resync (`user-hub.ts:315-326`); `timerStop`, `timerSwitch`, and the alarm's auto-start (`:551` discards the `timerStart` result while the phase is already set to focus) don't → pomo/timer state can drift.
6. **Email column doubles as username** for mail-less users (`admin.ts:52-58`) — a legacy bridge that makes "email" untrustworthy everywhere it's read (login `OR email = ?1 COLLATE NOCASE`, reset flow checks `isValidEmail`, export shows it). Works, but every new feature touching identity re-pays the confusion.
7. **`civilRange` silently truncates at 1 500 days** (`shared/time.ts:104-113`, used by `reports.ts:37`) — a 5-year report range returns the first ~4 years with no error. Silent wrong answers are worse than 422s.
8. **`restoreMaxRows: 1_250_000` is guard theater** (`constants.ts:14`) — a payload that size would exhaust Worker CPU/memory long before the row cap matters; the *effective* protection is far below it. Import's real ceiling should be size-based (e.g. body ≤ N MB) instead.
9. **Reports recompute a full-table scan per request** (three aggregates over all sessions, `reports.ts:49-82`) — 2.9 s (summary, 180 d) and 5.1 s (heatmap, year) at only 20 k sessions `[dynamic]`; at the 200 k cap these approach Worker CPU limits. The 120/min heavy-limit is generous for endpoints this expensive; a per-user cache or pre-aggregation table is the eventual fix.
10. **Import performance is round-trip-bound** — **111 s to import 20 k sessions** `[dynamic]`: the import loop runs ~800 sequential D1 round-trips (per-50-row chunk: one `existingIds` SELECT + one batch, `export.ts:213-336`). Chunk size and per-chunk `existingIds` are the knobs; at the 200 k-session cap import is effectively unusable (~18 min, likely CPU death first).
11. **SPA bundle ships chart.js eagerly** — 441 KB / 143 KB gzip total; `DashboardView` is the only chart.js consumer and isn't the landing view — lazy-loading that chunk would cut initial payload roughly in half.
12. **`sessionStorage` device id** (`api.ts:5-14`) — every tab is a distinct "device": `hello` fan-out and the (UI-less) device list multiply per tab, and a browser restart per tab treats the same tab-id chain as new devices. `localStorage` (with a tab-unique suffix only for socket identity) would match user intuition.

---

## Appendix — verification

- **Probe suite** (kept outside the repo, `/tmp/opencode/audit/probes-audit.mjs`): 27 checks — 17 clean, 10 dynamically-confirmed findings (S1, S2, S3.1–S3.5, §5.3 ×2, plus rate-limit behavior notes). Unauth matrix, CSV-injection guard, and cross-user restore all behaved correctly.
- **Perf harness** (`/tmp/opencode/audit/perf.mjs`): timings above from local `wrangler dev` (local D1, no network latency; absolute numbers indicative, round-trip *counts* transfer to prod).
- **e2e:** all six scripts pass, including `regression-check`'s verify-email 429 expectation.
- **Server-log corroboration:** the wrangler dev log from the probe runs shows each finding live — the `NOT NULL constraint failed: tasks.position` 500 on `/api/import` (S3.5), `101 Switching Protocols` for the forced-change user's WS (S2), and three `Network connection lost` ProxyWorker drops under rapid sequential load (the AGENTS.md-documented flakiness; harmless with retry, worth knowing when scripting against it).
- **UX walkthrough caveat:** no desktop browser was attached to this session, so §4's UI findings are code-level (every item cites file:line) plus HTTP-level checks of the served shell/manifest/SW.

---

## Appendix — resolution status (post-audit fix pass)

All dynamically-confirmed findings were fixed and re-verified with the same probe suite: **27/27 checks now pass, 0 findings remain**. Baseline after fixes: `typecheck` ✅, 41/41 unit tests ✅, build ✅ (initial bundle 441 → 229 KB), all six e2e scripts ✅.

| Finding | Status |
|---|---|
| S1 — revoked sessions keep live WS | ✅ Fixed (session-id socket tags + selective `/revoke`; verified: socket closes 4001, receives no events) |
| S2 — WS skips forced-change gate | ✅ Fixed (upgrade path applies `active` + `must_change_password`; verified: no upgrade) |
| S3.1 — non-ULID ids via import | ✅ Fixed (merge mode requires ULID ids; verified: skipped) |
| S3.2 — 3-level hierarchy via import | ✅ Fixed (parent-in-file + root + same-project checks; verified) |
| S3.3 — cross-project dep via import/restore | ✅ Fixed (root-only + same-project checks both paths; verified) |
| S3.4 — negative-duration restore | ✅ Fixed (duration check; verified: rejected) |
| S3.5 — NaN binds → 500 | ✅ Fixed (row schemas; verified: 200 + skip, garbage coerced/clamped) |
| S3.6 — `created_at` mass assignment | ✅ Fixed (clamped to `[0, now]`; verified: ignored) |
| S4 — non-atomic KV rate counters | ✅ Fixed (atomic D1 `rate_counters` table, migration 0004; lockout-DoS documented as inherent, Turnstile is the prod mitigation) |
| S5 — unchecked `x-internal` | ✅ Fixed (DO verifies it on every route) |
| S6 — device-id echo, cookie regex, dead rule | ✅ Fixed (sanitized ids, `SESSION_COOKIE` constant, `signup_ip` rule removed) |
| §5.1 — 12h nudge alarm loop | ✅ Fixed (hourly repeat, never re-arms a past deadline) |
| §5.3 — layout/restore fan out nothing | ✅ Fixed (`layout.updated`/`restore.completed` events; MapView refetches; verified in `/sync`) |
| §5.4 — settings 3 round-trips | ✅ Fixed (single batch, both paths) |
| §5.5 — DO error-handling asymmetry | ✅ Fixed (stop/switch mirror-resync, auto-start rollback) |
| §5.8 — restoreMaxRows guard theater | ✅ Mitigated (8 MB body cap → 413) |
| §5.9 — silent 1500-day truncation | ✅ Fixed (422 `range_too_large`) |
| §5.10 — import throughput | ✅ Improved ~3× (111 s → 38 s for 20k sessions; further gains need larger D1 batches) |
| §5.11 — eager chart.js | ✅ Fixed (lazy Dashboard chunk; initial bundle halved) |
| §5.12 — per-tab device id | ✅ Fixed (`localStorage`) |
| §5.7 — email column doubling as username | ⚪ Left as-is (architectural; safe but every identity feature re-pays it) |
| §5.13 — reports full-table scan | ⚪ Left as-is (perf work deferred; 2–5 s at 20k sessions locally) |
| §3 — slop items (duplication, magic numbers, monoliths) | ✅ Fixed where mechanical (shared `startTimer`, `shared/constants` imported client-side, AdminPanel extracted, dead code removed, modal a11y hook); deeper refactors (SettingsView full split, LogView virtualization) noted as future work |
| §4 — features | ✅ Fixed the basics (logout, error boundary, global 401, PWA icons/manifest/SW, keyboard/a11y gaps, fetch races, busy states); new features (calendar view, billable rates, 2FA, …) are product work — see §4 recommendations |

**Deliberately not touched:** schema for `users.totp_secret` / `oauth_accounts` (removal needs a destructive migration; AGENTS.md mandates additive-only migrations — decide when 2FA/OAuth is either built or dropped) and the single-timer/`sync_log` architecture (sound as designed).
