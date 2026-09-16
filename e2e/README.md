# End-to-End Verification Scripts

These scripts verify the app end-to-end against `wrangler dev`
(local D1 + Durable Objects). They are self-contained and portable.

## Prerequisites

```bash
npm install
npm run db:migrate:local     # apply D1 migrations to the local database
npm run dev:worker           # starts wrangler dev on http://127.0.0.1:8787
```

Accounts are admin-managed (no self-signup): the smoke test signs in as the
seeded admin (`admin` / `changemeasap` — it replaces the default password with
`ADMIN_PASSWORD` on first run; default `purple-marmalade-admin-42`, override
via env). It creates its own test users (`dana`, `milan`); the other scripts
reuse them. For the login rate limit, set the `RL_*` overrides from
`.dev.vars.example` in your `.dev.vars`.

## Scripts

| Script | What it verifies |
|--------|------------------|
| `smoke-test.sh` | Full API walkthrough: no-signup (404), admin login + forced password change, user creation/deactivation/password reset, gate 403s, bootstrap, projects/tasks/subtasks (incl. FR-T3 422), dependencies + cycle 422, timer start/409/switch/stop, manual sessions + overlap 409, Tehran-bucketed reports, sync event log, export JSON/CSV, authz isolation 404, CSRF 403, rate-limit 429 |
| `roundtrip-test.mjs` | export → delete-account → import identity round-trip (data survives account deletion + restore) |
| `undo-test.mjs` | undo/restore round-trip for deleted tasks/sessions |
| `ws-test.mjs` | cross-device WebSocket fan-out (hello/timer events via the UserHub Durable Object) |

## Usage

With `wrangler dev` running in another terminal:

```bash
bash e2e/smoke-test.sh        # run this first — it creates the test users
node e2e/roundtrip-test.mjs
node e2e/undo-test.mjs
node e2e/ws-test.mjs
```

All scripts target `http://127.0.0.1:8787`. `roundtrip-test.mjs` deletes the
`dana` account — re-run the smoke test afterwards to recreate it.
