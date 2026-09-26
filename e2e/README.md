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

`write-limit-test.mjs` is the exception: it needs its own throwaway instance
(fresh state dir + `--var RL_WRITE_USER:5`), so run it via
`bash scripts/run-e2e.sh`, which starts and reaps that instance for you.

CI runs the whole suite automatically (see `scripts/run-e2e.sh`).
