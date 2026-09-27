# End-to-End Verification Scripts

The full catalog — all scripts, what each verifies, and the run order — lives
in **[../docs/testing.md](../docs/testing.md)**.

Quick start:

```bash
npm run db:migrate:local     # once, before the first run
npm run dev:worker           # in another terminal — http://127.0.0.1:8787
bash e2e/smoke-test.sh       # first — creates the shared test users
node e2e/roundtrip-test.mjs  # last — deletes the dana account
```

Two scripts need their own throwaway instances, so run them via
`bash scripts/run-e2e.sh`, which starts and reaps those for you:

- `write-limit-test.mjs` — a fresh state dir and small limits
  (`--var RL_WRITE_USER:5 --var RL_WRITE_USER_DAY:5`), because a burst big enough
  to trip the production defaults would take minutes through the local proxy.
- `session-race-test.mjs` — a fresh state dir **seeded** with sessions already
  inside the 7-day token-rotation window (`scripts/gen-session-race-seed.mjs`).
  The rotation path cannot otherwise be reached over HTTP: the seeded admin
  cannot be pushed there, and waiting out 23 days of a 30-day TTL is not an
  option.

`scripts/with-dev-instance.sh <port> <state> <log> <command>` is the helper that
does one of those runs, if you want a single script on a private instance.

CI runs the whole suite automatically (see `scripts/run-e2e.sh`).
