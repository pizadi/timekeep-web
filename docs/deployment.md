# Deployment (Cloudflare)

Deploying your own TimeKeep Web instance. One Worker serves the API and the
SPA; you need a Cloudflare **Workers Paid** plan (see
[Why Workers Paid](#why-workers-paid)).

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
for recovery if it's ever lost).

## Configuration reference

All of these are optional — the app degrades gracefully:

| Name | Kind | Effect |
|---|---|---|
| `RESEND_API_KEY` | secret | verification/password-reset mail via Resend. Absent → mail simply unavailable (the admin can still reset passwords from the panel) |
| `TURNSTILE_SECRET_KEY` | secret | bot defense on auth endpoints. Absent → off |
| `TURNSTILE_SITE_KEY` | var (public) | enables the widget in the UI + CSP additions |
| `FROM_EMAIL` | var | mail sender address |
| `PBKDF2_ITERATIONS` | var | KDF rounds; keep `600000` in prod, lower only for local dev |
| `ALLOWED_ORIGINS` | var | comma-separated origins allowed for state-changing requests (defaults to the request origin; set it when serving from a custom domain) |
| `EMAIL_DEV_MODE` | var | dev only — logs mail links to the console instead of sending |

## Why Workers Paid

The default PBKDF2 iteration count (600,000, chained as 6 × 100k rounds
because the runtime caps a single call at 100k) exceeds the free tier's
10 ms CPU budget on the login path. Workers Paid ($5/mo) is required for the
default KDF settings. Lower `PBKDF2_ITERATIONS` only for local dev.

## Daily cron

A scheduled handler runs at **03:17 UTC** daily (`cron.ts`):

- dumps all tables to the R2 bucket as NDJSON (streamed multipart, 30-day
  retention) — no R2 bucket configured → dumps are skipped, everything else
  still runs
- prunes `sync_log`, expired sessions, and expired email tokens

## Upgrades

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
