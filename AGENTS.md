# AGENTS.md — TimeKeep Web

Time tracking SPA (React/Vite) + API on Cloudflare Workers, D1, and Durable Objects.
One Worker serves everything: Hono handles `/api/*`, Static Assets serve the SPA
(`run_worker_first: true`). Vite root is `src/web`; the SPA builds to `dist/client`.

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

- Full local check: `npm run typecheck && npm test && npm run build`. No lint/format tooling is configured.
- E2E scripts (`e2e/smoke-test.sh`, `ws-test.mjs`, `roundtrip-test.mjs`, `undo-test.mjs`,
  `security-probes.mjs`, `regression-check.mjs`, `pomo-mode-test.mjs`) target `127.0.0.1:8787`
  and create their own accounts. They hammer the login endpoint — set `RL_LOGIN_IP`/
  `RL_LOGIN_EMAIL`/`RL_ADMIN_IP` overrides from `.dev.vars.example` in `.dev.vars`
  (but NOT `RL_TOKEN_IP` — `regression-check.mjs` expects the verify-email hammer to actually 429).
  Run `smoke-test.sh` first — the other scripts reuse the users it creates; `roundtrip-test.mjs`
  last (it deletes the `dana` account).
- `wrangler dev`'s local proxy intermittently drops requests under rapid sequential e2e load
  (`Error: Network connection lost` → the script dies on a random step). Re-run before investigating.

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

## Architecture rules

- `src/shared/` is isomorphic — included by BOTH `tsconfig.worker.json` and `tsconfig.web.json`.
  Changes there must typecheck in both (this is why `typecheck` runs two projects).
- Single-timer invariant: partial unique index `time_sessions(user_id) WHERE ended_at IS NULL`
  in D1 + `UserHub` DO (`src/worker/do/user-hub.ts`) as the operational authority. Never write
  per-tick rows.
- Time: instants are epoch-ms UTC everywhere. Day/week bucketing uses the `Intl`-based engine in
  `src/shared/time.ts` fed into SQL via a `json_each()` day table — don't move aggregation
  client-side; API clients receive report buckets, never raw session rows.
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
- End-of-run pomodoro notifications (`decide`/`ready` phases) bypass the `notifications_enabled`
  toggle (they need only browser permission, requested when pomodoro is enabled in Settings);
  every other notification respects the toggle. Notification permission is never requested
  anywhere else.
- No native `<datalist>` pickers — use `src/web/components/Combobox.tsx`. Inside modals/grids,
  `.input` needs `min-width: 0` and `1fr` tracks must be `minmax(0, 1fr)` (a `datetime-local`'s
  intrinsic width overflows the dialog otherwise — the v0.1.0 dialog-clip fix).

## Commits

- Keep commit messages short: a single subject line (optionally 1–2 body lines).
- Detailed change notes go in `CHANGELOG.md` (included in the same commit), not in the
  commit message.
