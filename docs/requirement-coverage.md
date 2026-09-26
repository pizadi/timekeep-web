# Requirement coverage & known trade-offs (detailed)

Preserved from the original README for reference. Requirement IDs refer to the
TimeKeep-Web requirements spec (v1.0-draft).

> **Deviation from spec (2026-09):** self-signup (FR-A1) was replaced by
> admin-managed accounts — there is no sign-up form or endpoint; a single
> seeded admin creates, deactivates and resets users via `/api/admin/*`.
> Usernames are the login identifier; email is optional (reset mail only).
> See `migrations/0002_usernames_admin.sql` and `src/worker/routes/admin.ts`.

## Requirement coverage

**Must-haves — implemented**

| Req                                                                                                                                                                          | Where                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| FR-A1 signup + verification + common-password list                                                                                                                           | `routes/auth.ts`, `10k-most-common.txt` (signup → admin-managed, see deviation above; verification/resend + `/verify` view) |
| FR-A2 login (rate limits, Turnstile-ready, generic errors)                                                                                                                   | `routes/auth.ts`, `middleware.ts`                                                                                           |
| FR-A5 password reset (no enumeration, revokes sessions)                                                                                                                      | `routes/auth.ts` + `views/ResetPasswordView.tsx` (the `/reset?token=…` SPA route)                                           |
| FR-A6 session management (hashed tokens, list, revoke, rotation)                                                                                                             | `middleware.ts`, `routes/me.ts`                                                                                             |
| FR-A7 profile: name / IANA timezone / week start                                                                                                                             | `routes/me.ts`                                                                                                              |
| FR-A8 account deletion (hard cascade + deletion log)                                                                                                                         | `routes/me.ts`                                                                                                              |
| FR-P1–P4 projects: CRUD, archive, colors, reorder, 200 limit                                                                                                                 | `routes/projects.ts`                                                                                                        |
| FR-T1–T7 tasks, subtask checklists, two-level enforcement, cheap editing, done state, quick-find, limits                                                                     | `routes/tasks.ts`, `views/TreeSidebar.tsx`, `components/QuickFind.tsx`                                                      |
| FR-S1–S7 timer (start/stop/switch, server-authoritative), live duration, crash recovery, manual entry + overlap guards, log, edit/delete with undo, notes                    | `do/user-hub.ts`, `routes/sessions.ts`, `routes/timer.ts`, `views/LogView.tsx`                                              |
| FR-F1–F6 soft pomodoro (tracked-seconds focus, decide prompt, explicit break, skip, config, ring)                                                                            | `do/user-hub.ts`, `components/TimerBar.tsx`                                                                                 |
| FR-M1–M9 map: per-project DAG, visual add/remove, cycle rejection with path toast, edge semantics, status visuals, interaction hygiene, layout persistence, editing from map | `views/MapView.tsx`, `routes/tasks.ts`, `routes/misc.ts`                                                                    |
| FR-R1–R7 dashboard: stacked bars w/ midnight clipping, donut, heatmap, totals table, auto-update on events, running-session inclusion, remembered range                      | `routes/reports.ts`, `views/DashboardView.tsx`                                                                              |
| FR-U1–U5 themes (+system), responsive tiers, WCAG-minded a11y, keyboard shortcuts, tab-title/favicon tray                                                                    | `styles.css`, `App.tsx`, `components/TimerBar.tsx`                                                                          |
| FR-C1–C2 settings surface + usable defaults                                                                                                                                  | `routes/misc.ts`, `views/SettingsView.tsx`                                                                                  |
| FR-N1–N3/N5 WebSocket per device, full event catalog, reconnect delta (`?since=`), polling fallback, offline banner                                                          | `do/user-hub.ts`, `lib/store.ts` (WS + reconcile polling), `routes/misc.ts`                                                 |
| FR-D1/D3 export JSON+CSV, R2 dumps + retention, sync_log prune                                                                                                               | `routes/export.ts`, `cron.ts`                                                                                               |
| FR-Nt1 notifications (permission-gated, phase changes)                                                                                                                       | `components/TimerBar.tsx`                                                                                                   |
| NFR-1..NFR-10                                                                                                                                                                | see README architecture section; tests for NFR-6 in `test/time.test.ts`                                                     |

**Should/Could — status**

| Req                                  | Status                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-A3 OAuth (Google/GitHub)          | Not implemented — `oauth_accounts` table and merge-by-verified-email design reserved; needs provider credentials to test honestly                                |
| FR-A4 magic links                    | Not implemented (token machinery exists via `email_tokens.purpose='magic'`)                                                                                      |
| FR-A9 TOTP                           | Not implemented (column reserved)                                                                                                                                |
| FR-P3 bulk archive                   | Not implemented                                                                                                                                                  |
| FR-R8 CSV of any report view         | Partially — full sessions CSV export exists (`/export?format=csv`)                                                                                               |
| FR-U6 PWA installability             | Implemented (manifest + shell-caching SW)                                                                                                                        |
| FR-N4 presence hint                  | Partial — device count in `hello`/`/sync` shown in store                                                                                                         |
| FR-Nt2 Web Push, FR-Nt3 weekly recap | Not implemented (v2 candidates per spec)                                                                                                                         |
| FR-D2 import                         | Implemented — merge-by-id and duplicate modes with per-entity summary; the same DAG-cycle, overlap-sanity and entity-limit rules as the CRUD routes are enforced |

**Deliberately excluded** (per spec §2.5): idle detection / auto-pause in any form —
no presence heuristics, Page Visibility tricks, or permission prompts exist in
this codebase.

## Audit follow-ups (0.5.3)

Items from the repo audit, re-verified against the current tree and closed:

| Area                    | Now                                                                               |
| ----------------------- | --------------------------------------------------------------------------------- |
| Write rate limiting     | `limitWrites` / `write_user` (`RL_WRITE_USER`) on every mutating route            |
| Capacity caps           | enforced inside the INSERT/UPDATE, not by a prior `SELECT COUNT(*)`               |
| Reset-request timing    | email send on `waitUntil`; skip branches burn equivalent work                     |
| Seeded admin credential | the daily cron logs `SECURITY_admin_default_password` while it still works        |
| CSP                     | `style-src-elem 'self'` containment + `test/csp.test.ts` guards the no-sinks rule |
| Lint/format             | ESLint + Prettier, both blocking in CI                                            |
| Chained PBKDF2          | documented (no change needed)                                                     |
| Reserved schema         | `oauth_accounts` / `users.totp_secret` documented as unused placeholders          |
| Chat newlines           | `white-space: pre-wrap` on message bodies                                         |

## Known trade-offs

- Bootstrap returns the user's full tree in one shot (fast for ≤ a few thousand
  tasks); larger accounts should paginate `/bootstrap`.
- Inline export caps at the practical Worker memory size (~100k sessions);
  larger accounts should use the R2 dump path — the Queues-based async export
  from FR-D1 is stubbed by the dump machinery.
- KV rate counters are eventually consistent (documented in spec §2.4 as the
  intended trade-off). The hot per-user `api_user` counter lives in the user's
  UserHub DO (atomic, single-instance); KV remains the fallback and the
  counter for cold per-IP/per-email limits. Swap in the Workers Rate Limiting
  binding for stricter enforcement.
- The map targets 300 nodes/30 fps with plain SVG; a canvas renderer would be
  the next step if profiling demands it.
- Password hashing chains 6 × 100k-round PBKDF2 calls (the Workers runtime caps
  one `deriveBits` call at 100k). This matches a single 600k call in work
  factor only — a chained construction, not literally PBKDF2-600k; the stored
  `pbkdf2$600000$…` prefix is a format label, not an interop claim.
- `users.email` doubles as the login identifier for users without a real
  mailbox (username stored there, `@`-free) — every email path must keep the
  `includes('@')` convention in mind.
- `run_worker_first: true` routes every static-asset request through the Worker
  (uniform security headers on the SPA shell); a latency/cost tax worth
  re-measuring if asset traffic dominates.
- The seeded admin's precomputed password hash is committed in
  `migrations/0002_usernames_admin.sql` — the default credential is public
  knowledge in the repo and forced to change at first login; rotate it
  immediately after first sign-in on any real deployment.
- CSP carries `style-src 'unsafe-inline'` for React inline styles — a
  documented trade-off (see `middleware.ts`).
