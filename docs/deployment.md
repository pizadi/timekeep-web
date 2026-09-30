# Deployment (Cloudflare)

Deploying your own TimeKeep Web instance. One Worker serves the API and the
SPA; the Workers **free** plan is sufficient (see
[Plan requirements](#plan-requirements)).

## 1. Create resources

```bash
npx wrangler d1 create timekeep          # → database id
npx wrangler kv namespace create KV      # → namespace id
npx wrangler r2 bucket create timekeep-dumps   # optional: daily dumps
```

## 2. Fill in the ids

The committed `wrangler.jsonc` is a template with `REPLACE_ME` placeholders.
Keep it that way — resource ids stay out of the repo:

- Copy `wrangler.jsonc` → `wrangler.local.jsonc` (gitignored) and replace the
  ids there.
- **Keep the `define` block in sync** between the two files — the
  `__APP_VERSION__` value bumps together with `package.json` on release
  (CI guards the committed copy via `scripts/check-version.mjs`).

All local deploys and remote migrations use `-c wrangler.local.jsonc`
(`npm run db:migrate:remote` alone reads the template).

## 3. Migrate + secrets

```bash
npm run db:migrate:remote                 # = wrangler d1 migrations apply timekeep --remote -c wrangler.local.jsonc
npx wrangler secret put RESEND_API_KEY -c wrangler.local.jsonc         # optional: verification/reset email
npx wrangler secret put TURNSTILE_SECRET_KEY -c wrangler.local.jsonc   # optional: bot defense
```

## 4. Deploy

```bash
npm run build && npx wrangler deploy -c wrangler.local.jsonc
```

Live check: `GET /api/version` → `{name, version, build, now}` — `version`
is the app semver, `build` the deploy SHA (`"dev"` for ad-hoc local builds).

On first sign-in the seeded admin (`admin` / `changemeasap`) is forced to set
a real password. Rotate it immediately on any real deployment — the default
is public knowledge (see the [admin guide](admin-guide.md#admin-account-recovery)
for recovery if it's ever lost). The daily cron verifies the seeded password
against the admin hash and logs a `SECURITY_admin_default_password` warning
while it still works, so check the logs after deploying.

## Configuration reference

All of these are optional — the app degrades gracefully:

| Name                   | Kind         | Effect                                                                                                                                 |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`       | secret       | verification/password-reset mail via Resend. Absent → mail simply unavailable (the admin can still reset passwords from the panel)     |
| `TURNSTILE_SECRET_KEY` | secret       | bot defense on auth endpoints. Absent → off                                                                                            |
| `TURNSTILE_SITE_KEY`   | var (public) | enables the widget in the UI + CSP additions                                                                                           |
| `FROM_EMAIL`           | var          | mail sender address                                                                                                                    |
| `PBKDF2_ITERATIONS`    | var          | KDF rounds; keep `600000` in prod, lower only for local dev                                                                            |
| `ALLOWED_ORIGINS`      | var          | comma-separated origins allowed for state-changing requests (defaults to the request origin; set it when serving from a custom domain) |
| `EMAIL_DEV_MODE`       | var          | dev only — logs mail links to the console instead of sending                                                                           |

## Plan requirements

The Workers **free** plan is sufficient — TimeKeep runs on it in production.
A previous revision of this doc claimed Workers Paid ($5/mo) was required for
the default KDF settings; that was a mistake, and the reasoning behind it was
wrong too: the chained PBKDF2 rounds are runtime-provided async WebCrypto
calls (`crypto.subtle.deriveBits`), whose wall time is not billed against the
free plan's 10 ms/request **CPU** budget the way JS execution is. The 600k
default (6 × 100k chained rounds) runs comfortably on free — check
**Workers & Pages → timekeep-web → Metrics → CPU time** to see it.

Limits that actually apply on free (raise only if an instance outgrows them):

| Resource                                | Free allowance                               |
| --------------------------------------- | -------------------------------------------- |
| Workers requests                        | 100,000/day, 10 ms CPU per request           |
| D1 rows read / written                  | 5M/day, 100k/day                             |
| D1 storage                              | 500 MB per database, 5 GB per account        |
| D1 Time Travel (point-in-time recovery) | 7 days                                       |
| Durable Objects, KV, cron, R2 dumps     | available on free (standard free allowances) |

An upgrade to Workers Paid removes the daily caps — that's its only role here.

## Backups

Two independent safety nets exist. Know both before you need either.

### 1. D1 Time Travel (always on)

D1 keeps point-in-time snapshots for the window in the
[plan-requirements table](#plan-requirements) — restore from the Cloudflare
dashboard (**Storage & Databases → D1 → timekeep → Time Travel**) or:

```bash
npx wrangler d1 time-travel restore timekeep -c wrangler.local.jsonc
```

This is the primary recovery path for accidents inside the window (a bad
migration, an accidental delete). It cannot help with older damage or total
loss — that is what the dump is for.

### 2. The daily R2 dump (opt-in)

The daily cron (03:17 UTC, `cron.ts`) dumps every persistent table to the R2
bucket as NDJSON — one `dumps/<date>/dump.jsonl` object per day, kept 30 days:

- **Complete:** every table the migrations define except the transient ones
  (`sync_log`, `rate_counters`, `active_timers`, `email_tokens`,
  `auth_sessions`). The manifest is pinned by `test/cron-dump.test.ts` against
  the live schema, so a migration that adds a table/column fails CI until the
  dump manifest is updated — backups can't silently lose coverage.
- **No credentials:** `users.password_hash`, `users.totp_secret` and
  `group_invite_links.token_hash` are excluded (the dump is plaintext JSONL).
  Restored users have no password — use the admin panel to set one.
- It also prunes `sync_log`, expired sessions, and expired email tokens.

**Without an R2 binding the dump is skipped** and the cron logs
`SECURITY_backup_not_configured` on every run — an instance without the
binding has no dump, only Time Travel. Enable it:

```bash
npx wrangler r2 bucket create timekeep-dumps
# then in wrangler.local.jsonc (keep the committed template's "r2_buckets": []):
#   "r2_buckets": [{ "binding": "R2", "bucket_name": "timekeep-dumps" }]
```

A failed dump logs `cron_dump_failed` and rethrows — the other cron jobs still
ran, but the missing object is the alarm. Check for `dumps/<today>/…` if you
ever suspect the cron.

### Restore runbook (rehearse before you need it)

1. Fetch the newest healthy object:
   `npx wrangler r2 object get timekeep-dumps/dumps/<date>/dump.jsonl --file dump.jsonl`
2. Create + migrate a scratch database (same schema version as the dump):
   `npx wrangler d1 create timekeep-restore` and apply `migrations/` to it.
3. Replay: the dump is JSONL, one `{"t": "<table>", "row": {…}}` object per
   line. Group rows by table and insert each with `INSERT OR REPLACE` — the
   dump is the truth, so schema-seeded rows (the admin user from migration 0002) are overwritten and a partially-applied restore can be re-run.
4. Verify row counts per table against the dump, then point the instance at
   the restored database (or export per-user from it).

The replay recipe was rehearsed end-to-end when this section was written
(dump produced by the real cron against a local workerd R2, replayed into a
scratch SQLite with foreign keys on). Rehearse it again whenever the schema
changed shape — a restore you have never run is not a restore.

## Deploying from GitHub (CI/CD)

`.github/workflows/deploy.yml` deploys from GitHub — no local machine needed:

- **Triggers:** manual (**Actions → Deploy → Run workflow**) and automatic on
  any `vX.Y.Z` tag push. Dev versions never deploy from tags: the tag filter
  excludes `v*.dev*` and `scripts/check-release-tag.mjs` fails the run if the
  tagged commit's package.json isn't a clean `x.y.z` matching the tag.
- **CI gate (INV-07):** nothing deploys until the FULL CI suite — lint,
  format:check, typecheck, unit tests and the whole e2e/security suite — has
  passed **for the exact sha being deployed**. A tag push starts CI and this
  workflow at the same moment, so the gate polls (30 s, up to 25 min) and reports
  the CI run's URL. A failing, cancelled or missing CI run blocks the deploy with
  the reason.
- **Approval gate:** the job runs in the `production` environment — add
  required reviewers under **Settings → Environments → production** and every
  deploy waits for (your) approval in the UI.
- **Config rendering:** `scripts/render-wrangler.mjs` merges the committed
  `wrangler.jsonc` template with GitHub variables at run time — resource ids
  never live in the repo. The rendered `wrangler.ci.jsonc` is gitignored.

> Manual deploy from a ref with no CI run for that sha is refused on purpose. Run
> **Actions → CI → Run workflow** for the same ref first (or push the commit to
> `main`, or push the release tag) and re-dispatch the deploy.

One-time setup:

1. **API token** — Cloudflare dashboard → My Profile → API Tokens → Create
   (custom), scoped to the account with: _Workers Scripts: Edit_, _D1: Edit_,
   _Workers KV Storage: Edit_ (plus _R2: Edit_ only if the R2 dump bucket is
   used).
2. **Repo secrets** (Settings → Secrets and variables → Actions → Secrets):
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. **Repo variables** (same page → Variables): `CF_D1_DATABASE_ID`,
   `CF_KV_NAMESPACE_ID`, and `CF_DEPLOY_URL` (e.g.
   `https://timekeep-web.parham-avia.workers.dev`) for the post-deploy check.
4. **Repo variable `CF_APP_PUBLIC_URL`** — the canonical `https://` origin for
   password-reset and verification emails. Those links carry a bearer token, so
   the origin is deployment configuration rather than something derived from the
   request: unset, the Worker falls back to the request's origin and a Host
   header the deployment accepts could aim the token at another domain. The
   deploy run warns when it is empty.
5. **Environment** — Settings → Environments → create `production`, add the
   required reviewer(s).

Each run: CI gate (full suite, this sha) → guard release tag → render config →
build → **remote D1 migrations** (idempotent, additive-by-policy) →
`wrangler deploy` → verify
`GET /api/version` reports the `package.json` version and the deployed commit
sha. App secrets (`RESEND_API_KEY`, Turnstile) live in the Worker and are
never touched by deploys. Deploys to the same environment queue behind each
other (`concurrency: production`) — a running deploy is never cancelled.

**Rollback:** run `npx wrangler rollback -c wrangler.local.jsonc` locally, or
re-run the deploy workflow run of an earlier `vX.Y.Z` tag to redeploy it
(open the run → Re-run all jobs — the gate re-verifies before deploying).

## Upgrades

Prefer the GitHub deploy workflow above — it runs the same steps with an
approval gate and a post-deploy check. Manual upgrade for local use:

```bash
git pull
npm ci
npm run build
npm run db:migrate:remote      # apply any new migrations first
npx wrangler deploy -c wrangler.local.jsonc
curl -s https://<your-worker>/api/version   # confirm the new version
```

**Rollback:** `npx wrangler rollback -c wrangler.local.jsonc` rolls back to
the previous deployed version. New migrations are additive by policy, so a
code rollback never requires a DB rollback.

## Admin account recovery

The admin username has no mailbox, so reset mail doesn't apply. To reset a
lost admin password: delete the admin row, then re-run the seeded `INSERT`
from `migrations/0002_usernames_admin.sql`:

```bash
npx wrangler d1 execute timekeep --remote -c wrangler.local.jsonc \
  --command "DELETE FROM users WHERE username='admin'"
# re-apply the INSERT from migrations/0002_usernames_admin.sql the same way
```

That restores the default password `changemeasap` (forced change at next
login).

## Custom domain

Point a domain at the Worker via the Cloudflare dashboard
(**Workers & Pages → timekeep-web → Domains & Routes**) and set
`ALLOWED_ORIGINS` to your worker/origin URLs if you serve from more than one.
