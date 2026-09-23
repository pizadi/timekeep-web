# Development

Setting up and working on TimeKeep Web locally.

## Prerequisites

- Node 22+ and npm (CI pins Node 22; local dev on newer Node is fine)
- No database or services to install — D1, KV and the DO run locally inside
  `wrangler dev` (miniflare/workerd), state under `.wrangler/state/`

## First run

```bash
npm install
npm run db:migrate:local        # apply the D1 schema to the local database
npm run dev:worker              # wrangler dev on :8787 (API + SPA)
```

Open **http://localhost:8787** and sign in with the seeded admin account:

- username: `admin`
- password: `changemeasap` — you are required to set your own password on
  this first login

There is no sign-up form. Create users from **Settings → Admin — users** (see
the [admin guide](admin-guide.md)).

## Commands

| Command | What it does |
|---|---|
| `npm run dev:worker` | wrangler dev on :8787 — serves both API and SPA |
| `npm run dev:web` | Vite dev server on :5173, proxies `/api` (incl. WebSockets) to :8787 |
| `npm test` | unit tests (Vitest, node env — no DB or network needed) |
| `npm run typecheck` | typechecks the worker and web projects |
| `npm run build` | build the SPA → `dist/client` |
| `npm run db:migrate:local` / `:remote` | apply D1 migrations |
| `npm run deploy` | build + `wrangler deploy` |

Full local check before committing: `npm run typecheck && npm test && npm run
build`. There is no lint/format tooling configured.

## Dev servers

- `dev:worker` is self-sufficient: one process serves the API and the built
  SPA (no hot reload).
- `dev:web` adds the Vite dev server with hot reload on :5173; `/api` —
  including WebSocket upgrades — is proxied to :8787, so `wrangler dev` must
  still be running. Use this for UI work.

## `.dev.vars` (local secrets & overrides)

Copy `.dev.vars.example` → `.dev.vars` (gitignored, never commit). Everything
is optional in dev; the app degrades gracefully:

| Var | Effect |
|---|---|
| `PBKDF2_ITERATIONS=1000` | fast hashing for local logins (prod uses 600000) |
| `EMAIL_DEV_MODE=1` | prints verification/reset links to the Worker console — API responses never carry live token links |
| `FROM_EMAIL` | sender address for dev mail output |
| `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` | widget off when absent |
| `RESEND_API_KEY` | absent → password-reset mail unavailable |
| `RL_LOGIN_IP` / `RL_LOGIN_EMAIL` / `RL_ADMIN_IP` / `RL_TOKEN_IP` | rate-limit overrides for e2e hammering — set the first three high; leave `RL_TOKEN_IP` alone when running `regression-check.mjs` (it expects the 429) |

## Migrations

- Schema changes go in a new numbered file under `migrations/` (next N after
  the last), then `npm run db:migrate:local` / `db:migrate:remote`.
- **Additive `ADD COLUMN` migrations only.** D1 ignores
  `PRAGMA legacy_alter_table=ON`, and `ALTER TABLE … RENAME` rewrites child
  FK `REFERENCES` — so a table rebuild of any referenced table (e.g. `users`)
  makes `DROP TABLE` cascade-delete every child row. Migration 0003 exists in
  its `week_start_dow` form precisely because of this.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push/PR:

1. **verify** — `typecheck` (two tsc projects) → unit tests → SPA build
2. **version-sync** — `package.json` version must match the `__APP_VERSION__`
   define in `wrangler.jsonc` (`scripts/check-version.mjs`)
3. **e2e** — the full e2e suite against a fresh local `wrangler dev`
   (`scripts/run-e2e.sh`), blocking, with one automatic retry for the known
   wrangler-dev proxy flake

Details: [testing.md](testing.md).

## Versioning & releases

- Version strings are always `x.x.x` (release) or `x.x.x.devN` (dev
  iteration — N incremental from 1: `0.2.0.dev1`, `0.2.0.dev2`, …). No other
  spellings (`-dev.`, `devN` without the base).
- `package.json` is the source of truth; the SPA gets the version via the
  Vite `define` (from `package.json`), the worker via the `__APP_VERSION__`
  define — present in BOTH wrangler configs' `define` blocks.
- Dev iterations (`x.y.z.devN` commits) do **not** bump package.json — the
  devN lives in the commit message only.
- On release: bump all three places together (package.json +
  `__APP_VERSION__` in `wrangler.jsonc` AND `wrangler.local.jsonc`), commit,
  then annotated tag `vX.Y.Z`. CI's version-sync job guards the committed
  pair.

## Commits

- Format: `<version> — <one-line description>` (em dash), optionally 1–2 body
  lines.
- Each release ships a `CHANGELOG.md` briefly describing everything since the
  previous release — the newest changelog overwrites the file (git history
  keeps the old ones).

## `src/shared/` is isomorphic

Code under `src/shared/` is included by BOTH `tsconfig.worker.json` and
`tsconfig.web.json` — changes must typecheck in both (this is why
`typecheck` runs two tsc projects).
