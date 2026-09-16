# TimeKeep Web

A browser-based time-tracking and task-management application — a re-imagining of
TimeKeep Desktop for **Cloudflare Workers + D1 + Durable Objects**, with user
accounts and multi-device live sync as first-class concepts.

## Features

- **Projects → tasks → subtask checklists** (two levels, enforced)
- **Server-authoritative timer** — one running timer per user, live across all
  devices; ticks are never written (a 24 h session costs ~2 DB rows)
- **Soft pomodoro** — focus counts tracked seconds only; breaks never log time
- **Dependency map** — per-project task DAG with cycle rejection and saved layout
- **Live dashboard** — stacked bars / donut / heatmap / totals, updated in real
  time by sync events
- **Multi-device sync** — one WebSocket per device with reconnect deltas and a
  polling fallback when WebSockets are blocked
- **Admin-managed accounts** — no self-signup: a single seeded admin account
  creates/deactivates users and resets passwords from a built-in panel
- **Undo** — deletes can be restored for 5 seconds, byte-identical
- **Export / import** — JSON + CSV export; JSON import in merge-by-id or
  duplicate mode
- **Security** — PBKDF2 (600k iterations, chained per runtime limits), session
  management, rate limits, common-password rejection, optional Turnstile
- **Polished** — dark / light / system themes, responsive, keyboard-first,
  PWA-installable

## Tech stack

TypeScript end to end: [Hono](https://hono.dev) on the Worker, React 18 +
[Vite](https://vite.dev) for the SPA, [Zod](https://zod.dev) validation,
Chart.js dashboards, [Vitest](https://vitest.dev) unit tests.

## Quick start (local)

```bash
npm install
npm run db:migrate:local        # apply the D1 schema to the local database
npm run dev:worker              # wrangler dev on :8787 (API + SPA)
```

Open **http://localhost:8787** and sign in with the seeded admin account:

- username: `admin`
- password: `changemeasap` — you are required to set your own password on this
  first login

There is no sign-up form. Create users from **Settings → Admin — users**; they
get a temporary password and set their own at first login. You can deactivate
users (signs them out, blocks sign-in, keeps their data) and reset their
passwords. Optionally run the Vite dev server too (`npm run dev:web`, port
5173); it proxies `/api` — including WebSockets — to :8787 with hot reload.

## Commands

| Command | What it does |
|---|---|
| `npm run dev:worker` | wrangler dev on :8787 — serves both API and SPA |
| `npm run dev:web` | Vite dev server on :5173, proxies `/api` to :8787 |
| `npm test` | unit tests (no DB or network needed) |
| `npm run typecheck` | typechecks the worker and web projects |
| `npm run build` | build the SPA → `dist/client` |
| `npm run db:migrate:local` / `:remote` | apply D1 migrations |
| `npm run deploy` | build + `wrangler deploy` |

## End-to-end verification

Self-contained scripts that run against a local `wrangler dev` (start it in
another terminal first). The smoke test signs in as the seeded admin — override
with `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars if you already changed the
admin password (on first run it replaces the seeded `changemeasap` default
itself). It creates its own test users.

| Script | Verifies |
|---|---|
| `e2e/smoke-test.sh` | full API walkthrough: auth, CRUD, dependencies + cycles, timer, overlap guards, reports, sync, export, authz/CSRF/rate-limit rejections |
| `e2e/ws-test.mjs` | cross-device WebSocket fan-out via the UserHub Durable Object |
| `e2e/roundtrip-test.mjs` | export → delete account → import identity round-trip |
| `e2e/undo-test.mjs` | delete → restore identity round-trip |

## Deploy

The committed `wrangler.jsonc` ships with `REPLACE_ME` placeholders — create your
own resources and paste their ids as shown below.

```bash
wrangler d1 create timekeep                # put the id in wrangler.jsonc
wrangler kv namespace create KV            # put the id in wrangler.jsonc
wrangler r2 bucket create timekeep-dumps   # optional: daily dumps
npm run db:migrate:remote
wrangler secret put SESSION_SECRET         # openssl rand -hex 32
wrangler secret put RESEND_API_KEY         # optional: verification/reset email
wrangler secret put TURNSTILE_SECRET_KEY   # optional: bot defense
wrangler vars put TURNSTILE_SITE_KEY ...   # public; enables the widget + CSP additions
npm run deploy
```

Notes:

* **Workers Paid ($5/mo) is required for the default KDF settings** — the default
  PBKDF2 iteration count (600,000, chained as 6 × 100k rounds because the
  runtime caps a single call at 100k) exceeds the free tier's 10 ms CPU budget
  on the login path. Lower `PBKDF2_ITERATIONS` only for local dev.
* **Admin account recovery** — the admin username has no mailbox, so reset mail
  doesn't apply. To reset a lost admin password: delete the admin row
  (`DELETE FROM users WHERE username='admin'`), then re-run the seeded
  `INSERT` from `migrations/0002_usernames_admin.sql` via
  `npx wrangler d1 execute timekeep --remote --command "…"` — that restores the
  default password `changemeasap` (forced change at next login).
* Optional secrets degrade gracefully: no `RESEND_API_KEY` means password-reset
  mail is simply unavailable (the admin can reset passwords from the panel);
  no Turnstile keys means the widget is off.
* The daily cron (03:17 UTC) dumps all tables to R2 (30-day retention) and
  prunes `sync_log`.

## Project layout

```
migrations/0001_init.sql    D1 schema
src/shared/                 isomorphic code: ULID, timezone engine, validators
src/worker/index.ts         Worker entry: Hono app + UserHub DO + cron
src/worker/do/user-hub.ts   UserHub Durable Object: WS hub, timer authority, pomodoro
src/worker/routes/          API routes (auth, projects, tasks, sessions, reports, …)
src/web/                    React SPA: views/, components/, lib/
test/                       Vitest unit tests (DST fixtures, validators)
e2e/                        end-to-end verification scripts
```

## How it works (short version)

* **One Worker serves everything** — Hono handles `/api/*` (including WebSocket
  upgrades), Cloudflare Static Assets serve the SPA with an SPA fallback; all
  requests hit the Worker first (`run_worker_first`).
* **Single-timer invariant** — enforced by a partial unique index in D1 plus
  the per-user **UserHub Durable Object** as the operational authority, so two
  devices can never race a timer start.
* **Timezone correctness** — all instants are epoch-ms UTC; day/week bucketing
  boundaries are computed with `Intl` and pushed into SQL via a `json_each()`
  day table, so aggregation stays in the database. DST edge cases are covered
  by unit-test fixtures (Tehran / New York).
* **Event-driven sync** — every mutation appends to `sync_log` in the same D1
  batch as the write, then the DO fans out over WebSockets; clients that miss
  an event refetch via `GET /api/sync?since=`.

Detailed spec-coverage tables and known trade-offs live in
[docs/requirement-coverage.md](docs/requirement-coverage.md).
