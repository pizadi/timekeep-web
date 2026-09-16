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
- E2E scripts (`e2e/smoke-test.sh`, `ws-test.mjs`, `roundtrip-test.mjs`, `undo-test.mjs`) target
  `127.0.0.1:8787` and create their own accounts. They hammer the login endpoint — set
  `RL_LOGIN_IP`/`RL_LOGIN_EMAIL`/`RL_SIGNUP_IP` overrides from `.dev.vars.example` in `.dev.vars`.
  Run `smoke-test.sh` first — the other scripts reuse the users it creates.

## Env

- Copy `.dev.vars.example` → `.dev.vars` (gitignored). Everything is optional in dev;
  `EMAIL_DEV_MODE=1` makes signup/reset return verification links in API responses.
- Prod uses `PBKDF2_ITERATIONS=600000`; dev lowers it to 1000. Workers caps a single
  PBKDF2 `deriveBits` call at 100k iterations (`pbkdf2Chain` in `src/worker/auth.ts` chains
  rounds to reach the total) — never call `crypto.subtle.deriveBits` with PBKDF2 > 100k directly.
- Schema changes go in a new numbered file under `migrations/`, then `db:migrate:local` /
  `db:migrate:remote`.
- D1 gotcha: `PRAGMA legacy_alter_table=ON` is ignored and `ALTER TABLE … RENAME` rewrites child
  FK `REFERENCES`, so a table rebuild of any referenced table (e.g. `users`) makes `DROP TABLE`
  cascade-delete every child row. Additive `ADD COLUMN` migrations only (see 0003 — that's why
  `week_start_dow` exists beside the CHECK-constrained legacy `week_start`).

## Architecture rules

- `src/shared/` is isomorphic — included by BOTH `tsconfig.worker.json` and `tsconfig.web.json`.
  Changes there must typecheck in both (this is why `typecheck` runs two projects).
- Single-timer invariant: partial unique index `time_sessions(user_id) WHERE ended_at IS NULL`
  in D1 + `UserHub` DO (`src/worker/do/user-hub.ts`) as the operational authority. Never write
  per-tick rows.
- Time: instants are epoch-ms UTC everywhere. Day/week bucketing uses the `Intl`-based engine in
  `src/shared/time.ts` fed into SQL via a `json_each()` day table — don't move aggregation
  client-side; API clients receive report buckets, never raw session rows.
- Every mutation appends to `sync_log` in the same D1 batch as the entity write, then the DO
  fans out (`src/worker/events.ts`).
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
