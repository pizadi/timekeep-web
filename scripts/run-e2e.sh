#!/usr/bin/env bash
# CI helper: run the full e2e suite against a local `wrangler dev` on :8787.
# Used by .github/workflows/ci.yml (which supplies .dev.vars and runs this
# once, then once more on failure to absorb the wrangler-dev proxy flake).
#
# Order matters (see e2e/README.md + AGENTS.md):
#   smoke-test.sh first  — creates dana/milan and replaces the seeded admin
#                          password on the fresh DB
#   roundtrip-test.mjs last — it deletes the dana account
#   everything in between either creates its own users or reuses dana.
#
# With CI=true the local D1/KV state (.wrangler/state) is wiped first so every
# attempt starts from the deterministic seeded-admin database. Locally (no
# CI=true) the existing dev database is left untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=http://127.0.0.1:8787
LOG=/tmp/timekeep-wrangler-dev.log

if [ "${CI:-}" = "true" ]; then
	echo "CI: wiping local D1/KV state for a deterministic run"
	rm -rf .wrangler/state
fi

npm run db:migrate:local

npx wrangler dev --port 8787 >"$LOG" 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true' EXIT

echo "waiting for wrangler dev on $BASE ..."
ready=0
for _ in $(seq 1 120); do
	if curl -sf "$BASE/api/version" >/dev/null 2>&1; then ready=1; break; fi
	if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
		echo "wrangler dev exited early — log tail:"
		tail -50 "$LOG" || true
		exit 1
	fi
	sleep 1
done
if [ "$ready" -ne 1 ]; then
	echo "wrangler dev not ready after 120s — log tail:"
	tail -50 "$LOG" || true
	exit 1
fi

fail=0
run() {
	echo
	echo "=== $* ==="
	"$@" || fail=1
}

run bash e2e/smoke-test.sh
run bash e2e/subtask-sessions.sh
run node e2e/pomo-mode-test.mjs
run node e2e/ws-test.mjs
run node e2e/undo-test.mjs
run node e2e/pagination-day-check.mjs
run node e2e/security-probes.mjs
run node e2e/regression-check.mjs
run bash e2e/social-test.sh
run node e2e/roundtrip-test.mjs

if [ "$fail" -ne 0 ]; then
	echo
	echo "e2e suite FAILED — wrangler dev log tail:"
	tail -100 "$LOG" || true
	exit 1
fi
echo
echo "e2e suite passed (10/10 scripts)"
