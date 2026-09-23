# Changelog

## 0.4.0 — 2026-09-23

Everything since 0.3.0:

- **CI (GitHub Actions).** New `.github/workflows/ci.yml`, running on every
  push/PR: `verify` (typecheck for both tsc projects + unit tests + SPA
  build), `version-sync` (`scripts/check-version.mjs` fails when
  `package.json` and the `__APP_VERSION__` define in `wrangler.jsonc` drift
  apart), and a blocking `e2e` job — `scripts/run-e2e.sh` wipes local state
  (CI only), applies migrations, starts `wrangler dev`, runs all ten e2e
  scripts in dependency order, and retries once to absorb the known
  wrangler-dev proxy flake.
- **E2E fix.** `e2e/subtask-sessions.sh` could never pass on a fresh
  database: it posted a manual session 10 minutes into the past for a user
  created seconds earlier, tripping the `start is before the account
  existed` guard. It now uses future-tolerant windows like `smoke-test.sh`,
  and its print-only checks (four switch segments, no links to a deleted
  subtask) became hard asserts.
- **Shortened README, new `docs/` directory.** The README keeps the general
  description and the local/Cloudflare quick starts; everything in depth
  moved to `docs/`: `development.md` (dev servers, `.dev.vars`, migrations
  and the D1 table-rebuild gotcha, versioning & release process, commit
  format), `architecture.md` (one-Worker design, single-timer invariant,
  sync/event fan-out, timezone engine, security model, social layer),
  `testing.md` (unit tests + the full e2e catalog with run order),
  `deployment.md` (resource setup, config reference, upgrades, rollback,
  admin recovery), `admin-guide.md` (users, groups & permissions, backups),
  and the existing `requirement-coverage.md`. `e2e/README.md` is now a
  pointer into `docs/testing.md`.
