# Changelog

## 0.5.0 — 2026-09-24

Everything since 0.4.0:

- **CD — deploys from GitHub.** New `.github/workflows/deploy.yml`: deploys
  on manual dispatch (Actions → Deploy → Run workflow) and automatically on
  any `vX.Y.Z` tag push, through a protected `production` environment
  (required reviewers = approval gate in the UI; concurrent deploys queue and
  are never cancelled mid-run). Each run: CI gate (typecheck + tests) →
  renders the deploy config from the committed `wrangler.jsonc` template +
  GitHub variables (`scripts/render-wrangler.mjs` — resource ids stay out of
  the repo; the rendered `wrangler.ci.jsonc` is gitignored) → builds the SPA
  → applies remote D1 migrations (idempotent, additive-by-policy) →
  `wrangler deploy` → verifies `GET /api/version` reports the `package.json`
  version and the deployed commit sha. Rollback stays `npx wrangler
  rollback`, or re-run an earlier tag's deploy run to redeploy it.
- **Docs.** `docs/deployment.md` gained a "Deploying from GitHub (CI/CD)"
  section — one-time setup (API-token scoping: Workers Scripts/D1/KV Edit;
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets;
  `CF_D1_DATABASE_ID` / `CF_KV_NAMESPACE_ID` / `CF_DEPLOY_URL` variables;
  the `production` environment) and the two deploy paths.
