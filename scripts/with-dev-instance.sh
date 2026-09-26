#!/usr/bin/env bash
# Dev helper: run ONE e2e script against a private, disposable wrangler dev
# instance (own port, own D1 state), optionally seeding the database first.
#
# The concurrency/regression scripts that need a pristine database (a seeded
# admin password, fixture rows, a tiny rate limit) cannot share the :8787
# instance the rest of the suite uses — see scripts/run-e2e.sh, which drives the
# full suite and calls this for the write-limit and session-race cases.
#
# Usage: scripts/with-dev-instance.sh <port> <state-dir> <log-file> <script> [env=KV ...]
#   env assignments are exported to the script, e.g. TK_BASE=... node e2e/x.mjs
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=$1
STATE=$2
LOG=$3
SCRIPT=$4
shift 4

if [ -n "${SEED_SQL:-}" ]; then
	rm -rf "$STATE"
	npx wrangler d1 migrations apply timekeep --local --persist-to "$STATE" >/dev/null
	npx wrangler d1 execute timekeep --local --persist-to "$STATE" --file "$SEED_SQL" >/dev/null
	# `wrangler d1 execute` leaves its writes in the SQLite WAL, and a dev
	# instance started straight afterwards does not see them — the seeded rows
	# read as missing and every fixture request 401s. Checkpoint them into the
	# main database file (and let the -wal/-shm pair go) before booting workerd.
	for db in "$STATE"/v3/d1/*/*.sqlite; do
		case "$db" in
		*metadata.sqlite) continue ;;
		esac
		sqlite3 "$db" 'PRAGMA wal_checkpoint(TRUNCATE);' || true
	done
fi

mkdir -p "$(dirname "$LOG")"
npx wrangler dev --port "$PORT" --persist-to "$STATE" "$@" >"$LOG" 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 120); do
	if curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then break; fi
	if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
		echo "dev instance exited early:" >&2
		tail -30 "$LOG" >&2
		exit 1
	fi
	sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null
bash -c "$SCRIPT"
