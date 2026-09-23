# Testing

## Unit tests

```bash
npm test            # vitest run — node env, no DB or network needed
npx vitest run test/time.test.ts   # single file
```

Only `test/**/*.test.ts` is picked up. Current coverage:

| File | Covers |
|---|---|
| `time.test.ts` | `Intl` timezone engine incl. DST fixtures (Tehran / New York), week bucketing |
| `validation.test.ts` | Zod validators, restore-payload caps |
| `password.test.ts` | PBKDF2 chaining, common-password rejection |
| `cron.test.ts` | dump/prune logic |
| `ids.test.ts` | ULID helpers |
| `social.test.ts` | friend/group permission logic |
| `prompt-modal.test.ts` | SPA prompt modal |

## E2E suite

Self-contained scripts that run against a local `wrangler dev` (fresh local
D1 + DO). Prerequisites:

```bash
npm run db:migrate:local
npm run dev:worker          # in another terminal — http://127.0.0.1:8787
```

Accounts are admin-managed (no self-signup): `smoke-test.sh` signs in as the
seeded admin and replaces the default password (`changemeasap`) with
`purple-marmalade-admin-42` on first run — override with `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. It creates the test users (`dana`, `milan`); the other
scripts reuse them. Rate-limit overrides (`RL_LOGIN_IP`, `RL_LOGIN_EMAIL`,
`RL_ADMIN_IP` — **not** `RL_TOKEN_IP`) go in your `.dev.vars`, see
[development.md](development.md#devvars-local-secrets--overrides).

### Scripts (in run order)

| Order | Script | Verifies |
|---|---|---|
| 1 | `e2e/smoke-test.sh` | **run first** — full API walkthrough: no-signup (404), admin login + forced password change, user creation/deactivation/password reset, gate 403s, bootstrap, projects/tasks/subtasks, dependencies + cycle 422, timer start/409/switch/stop, manual sessions + overlap 409, Tehran-bucketed reports, sync events, export, authz isolation, CSRF, rate-limit 429. Creates `dana`/`milan` |
| 2 | `e2e/subtask-sessions.sh` | subtask attribution: starting on a subtask, switch splitting sessions, cross-task subtask link rejection, report subtask rows, delete-subtask keeps time |
| 3 | `e2e/pomo-mode-test.mjs` | pomodoro-as-timer mode: default off, plain start engages focus when on, switch re-anchors, skip/reset, legacy `/pomo/start` |
| 4 | `e2e/ws-test.mjs` | cross-device WebSocket fan-out via the UserHub DO (uses `dana`) |
| 5 | `e2e/undo-test.mjs` | delete → restore identity round-trip (uses `dana`) |
| 6 | `e2e/pagination-day-check.mjs` | page-based log pagination, `/reports/day` summary, subtask donut breakdown (uses `dana`'s smoke-run sessions) |
| 7 | `e2e/security-probes.mjs` | authn matrix, IDOR/authz, CSRF, forced-change gate, session revocation, response whitelists, rate limits, WS rejection |
| 8 | `e2e/regression-check.mjs` | targeted probes: open-ended manual sessions 422, no ghost timer after deletes, no reset links in responses, resend-verification, token-endpoint 429, import enforcement + events, cross-user restore |
| 9 | `e2e/social-test.sh` | friends, visibility, presence, groups + permissions, chat, group projects + group report (creates its own users) |
| 10 | `e2e/roundtrip-test.mjs` | **run last** — export → delete account → import identity round-trip; deletes the `dana` account |

Ordering rules: smoke first (creates the shared users), roundtrip last
(deletes `dana`). Everything in between either creates its own users or
reuses `dana`.

> Local quirk: `wrangler dev`'s DO proxy sometimes drops a request mid-run
> (`Network connection lost`) — the scripts retry transient drops, but if a
> run dies on a random step just re-run it; production is unaffected.

## CI

`.github/workflows/ci.yml` runs the whole suite in CI: the e2e job builds the
SPA, writes a CI `.dev.vars` (fast KDF, rate-limit overrides — no
`RL_TOKEN_IP`), wipes `.wrangler/state` for a deterministic fresh-DB run, and
executes `scripts/run-e2e.sh` — which applies migrations, starts
`wrangler dev`, waits for `/api/version`, then runs the ten scripts above in
the documented order. The job is blocking and retries once to absorb the
wrangler-dev proxy flake.
