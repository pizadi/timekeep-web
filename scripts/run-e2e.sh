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
#   write-limit-test.mjs gets a dedicated throwaway instance (see below).
#
# Logs and the throwaway D1 state live in .work/ (gitignored — AGENTS.md
# "Temp files and scratch state go in .work/", not /tmp).
#
# With CI=true the local D1/KV state (.wrangler/state) is wiped first so every
# attempt starts from the deterministic seeded-admin database. Locally (no
# CI=true) the existing dev database is left untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=http://127.0.0.1:8787
LOG=.work/wrangler-dev.log

# The write-limit script needs a DEDICATED instance (see the script header): a
# small RL_WRITE_USER so the burst is quick, and its own state dir so the seeded
# admin password is still the seeded one (smoke-test.sh rotates the shared
# instance's, and that instance is not disposable).
WL_PORT=8788
WL_STATE=.work/e2e-writelimit
WL_LOG=.work/wrangler-writelimit.log

mkdir -p .work

if [ "${CI:-}" = "true" ]; then
	echo "CI: wiping local D1/KV state for a deterministic run"
	rm -rf .wrangler/state
fi

npm run db:migrate:local

npx wrangler dev --port 8787 >"$LOG" 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true' EXIT

wait_ready() { # $1 = base url, $2 = pid, $3 = label, $4 = log path
	local base=$1 pid=$2 label=$3 log=$4 ready=0
	echo "waiting for $label on $base ..."
	for _ in $(seq 1 120); do
		if curl -sf "$base/api/version" >/dev/null 2>&1; then ready=1; break; fi
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "$label exited early — log tail:"
			tail -50 "$log" || true
			return 1
		fi
		sleep 1
	done
	if [ "$ready" -ne 1 ]; then
		echo "$label not ready after 120s — log tail:"
		tail -50 "$log" || true
		return 1
	fi
}

wait_ready "$BASE" "$WRANGLER_PID" wrangler-dev "$LOG" || exit 1

fail=0
run() {
	echo
	echo "=== $* ==="
	"$@" || fail=1
}

# Starts the disposable instance, runs the write-limit script against it, tears
# it down. Kept as a function so the failure path still reaps the second server.
run_write_limit() {
	echo
	echo "=== node e2e/write-limit-test.mjs (dedicated instance, RL_WRITE_USER=5) ==="
	rm -rf "$WL_STATE"
	npx wrangler d1 migrations apply timekeep --local --persist-to "$WL_STATE" >/dev/null 2>&1
	npx wrangler dev --port "$WL_PORT" --persist-to "$WL_STATE" --var RL_WRITE_USER:5 >"$WL_LOG" 2>&1 &
	local wl_pid=$!
	if wait_ready "http://127.0.0.1:$WL_PORT" "$wl_pid" wrangler-writelimit "$WL_LOG"; then
		TK_BASE="http://127.0.0.1:$WL_PORT/api" RL_WRITE_USER=5 node e2e/write-limit-test.mjs || fail=1
	else
		fail=1
	fi
	kill "$wl_pid" 2>/dev/null || true
	wait "$wl_pid" 2>/dev/null || true
}

run bash e2e/smoke-test.sh
run bash e2e/subtask-sessions.sh
run node e2e/pomo-mode-test.mjs
run node e2e/ws-test.mjs
run node e2e/undo-test.mjs
run node e2e/pagination-day-check.mjs
run node e2e/security-probes.mjs
run_write_limit
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
echo "e2e suite passed (11/11 scripts)"
