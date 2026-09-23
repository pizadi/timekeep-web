# TimeKeep Web

[![CI](https://github.com/pizadi/timekeep-web/actions/workflows/ci.yml/badge.svg)](https://github.com/pizadi/timekeep-web/actions/workflows/ci.yml)

A browser-based time-tracking and task-management application — a re-imagining
of TimeKeep Desktop for **Cloudflare Workers + D1 + Durable Objects**, with
user accounts and multi-device live sync as first-class concepts.

## Features

- **Projects → tasks → subtask checklists** (two levels, enforced)
- **Server-authoritative timer** — one running timer per user, live across
  all devices; ticks are never written (a 24 h session costs ~2 DB rows)
- **Soft pomodoro** — opt-in focus mode; breaks never log time
- **Dependency map** — per-project task DAG with cycle rejection
- **Live dashboard** — bars / donut / heatmap / totals, updated in real time
  by sync events
- **Multi-device sync** — one WebSocket per device with reconnect deltas and
  a polling fallback
- **Social layer** — friends, presence, groups with fine-grained permissions,
  group chat and shared group projects
- **Admin-managed accounts** — no self-signup: a seeded admin creates,
  deactivates and resets users from a built-in panel
- **Polish** — undo, JSON/CSV export + import, dark/light/system themes,
  keyboard-first, PWA-installable
- **Security** — PBKDF2, session management, rate limits, CSRF guards,
  optional Turnstile

TypeScript end to end: [Hono](https://hono.dev) on the Worker, React 18 +
[Vite](https://vite.dev) for the SPA, [Zod](https://zod.dev) validation,
Chart.js dashboards, [Vitest](https://vitest.dev) unit tests.

## Quick start (local)

```bash
npm install
npm run db:migrate:local        # apply the D1 schema to the local database
npm run dev:worker              # wrangler dev on :8787 (API + SPA)
```

Open **http://localhost:8787** and sign in as `admin` / `changemeasap`
(forced password change on first login). Create users from
**Settings → Admin — users**. Optionally run `npm run dev:web` for the Vite
dev server with hot reload (proxies `/api` to :8787).

## Deploy to Cloudflare

Requires Workers Paid ($5/mo) — see
[docs/deployment.md](docs/deployment.md#why-workers-paid).

```bash
npx wrangler d1 create timekeep && npx wrangler kv namespace create KV
# paste the ids into wrangler.local.jsonc (copy of wrangler.jsonc, gitignored)
npm run db:migrate:remote
npm run build && npx wrangler deploy -c wrangler.local.jsonc
```

Optional secrets (`RESEND_API_KEY`, `TURNSTILE_*`) degrade gracefully — full
setup, configuration reference, upgrades and rollback:
**[docs/deployment.md](docs/deployment.md)**.

## Documentation

| Doc | Contents |
|---|---|
| [docs/development.md](docs/development.md) | local dev, migrations, versioning & release process |
| [docs/architecture.md](docs/architecture.md) | how the system works, in depth |
| [docs/testing.md](docs/testing.md) | unit tests + the e2e suite (incl. CI) |
| [docs/deployment.md](docs/deployment.md) | Cloudflare setup, config & secrets, upgrades, rollback |
| [docs/admin-guide.md](docs/admin-guide.md) | running an instance: users, groups, backups |
| [docs/requirement-coverage.md](docs/requirement-coverage.md) | spec coverage & known trade-offs |

## License

MIT — see [LICENSE](LICENSE).
