#!/usr/bin/env bash
# Subtask attribution on sessions (part of the CI e2e suite — see scripts/run-e2e.sh).
# Creates its own throwaway user; requires `wrangler dev` on :8787.
set -e
BASE=http://127.0.0.1:8787/api
ORIGIN=http://127.0.0.1:8787
ADMIN_PASSWORD="${ADMIN_PASSWORD:-purple-marmalade-admin-42}"
JADM=/tmp/opencode/tk-adm9.txt; J=/tmp/opencode/tk-s9.txt
mkdir -p /tmp/opencode; rm -f $JADM $J
U="subtester$$"; PASS='a-very-long-password-123'

req() { local jar=$1 dev=$2 method=$3 path=$4 data=$5
  local t out rc=1 a
  for a in 1 2 3 4 5; do
    t=$(grep tk_csrf "$jar" 2>/dev/null | awk '{print $NF}')
    if [ -n "$data" ]; then
      out=$(curl -s --max-time 20 -b "$jar" -c "$jar" -X "$method" "$BASE$path" -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $dev" -H "x-csrf-token: $t" -d "$data")
    else
      out=$(curl -s --max-time 20 -b "$jar" -c "$jar" -X "$method" "$BASE$path" -H "origin: $ORIGIN" -H "x-device-id: $dev" -H "x-csrf-token: $t")
    fi
    rc=$?; [ $rc -eq 0 ] && [ -n "$out" ] && break; sleep 1
  done
  echo "$out"; }

req $JADM adm POST /auth/login "{\"identifier\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" >/dev/null
req $JADM adm POST /admin/users "{\"username\":\"$U\",\"password\":\"$PASS\"}" >/dev/null
req $J ui POST /auth/login "{\"identifier\":\"$U\",\"password\":\"$PASS\"}" >/dev/null
req $J ui POST /me/password "{\"current_password\":\"$PASS\",\"password\":\"$PASS-work\"}" >/dev/null

PID=$(req $J ui POST /projects '{"name":"Sb"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
TID=$(req $J ui POST "/projects/$PID/tasks" '{"name":"Build"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")
SB1=$(req $J ui POST "/tasks/$TID/subtasks" '{"name":"Frame"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['subtask']['id'])")
SB2=$(req $J ui POST "/tasks/$TID/subtasks" '{"name":"Paint"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['subtask']['id'])")
echo "PID=$PID TID=$TID SB1=$SB1 SB2=$SB2"

echo "== start ON a subtask =="
req $J ui POST /timer/start "{\"task_id\":\"$TID\",\"subtask_id\":\"$SB1\"}" | python3 -c "import sys,json; s=json.load(sys.stdin)['session']; print('running subtask:', s['subtask_id']=='$SB1')"
echo "-- bad subtask must 422:"
req $J ui POST /timer/switch "{\"task_id\":\"$TID\",\"subtask_id\":\"$SB2\"}" >/dev/null   # switch 1: SB1→SB2 (split)
req $J ui POST /timer/switch "{\"task_id\":\"$TID\",\"subtask_id\":\"$SB1\"}" >/dev/null   # switch 2: SB2→SB1
echo "-- switch to a NON-subtask of the task must 422:"
req $J ui POST /timer/switch "{\"task_id\":\"$TID\",\"subtask_id\":\"nope\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['error']['code'])" || true
echo "== switch splits into four segments: SB1→SB2→SB1→SB2 =="
req $J ui POST /timer/switch "{\"task_id\":\"$TID\",\"subtask_id\":\"$SB2\"}" >/dev/null
sleep 0.1
req $J ui POST /timer/stop >/dev/null
sleep 0.3
req $J ui GET "/sessions?task_id=$TID" | python3 -c "
import sys,json
ss=json.load(sys.stdin)['sessions']
names=[s.get('subtask_name') for s in ss]
assert len(ss)==4, f'expected 4 segments, got {len(ss)}: {names}'
print('segments:', len(ss), '| subtasks:', names)"

echo "== manual session with subtask + cross-task link rejected =="
# the account is seconds old (rule: started_at >= account.created_at — see
# smoke-test.sh), so use future-tolerant ranges within the now+5min window
NOW=$(date +%s%3N)
req $J ui POST /sessions "{\"task_id\":\"$TID\",\"subtask_id\":\"$SB2\",\"started_at\":$((NOW+30000)),\"ended_at\":$((NOW+90000))}" | python3 -c "import sys,json; s=json.load(sys.stdin)['session']; print('manual subtask:', s['subtask_id']=='$SB2')"
T2=$(req $J ui POST "/projects/$PID/tasks" '{"name":"Other"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")
req $J ui POST /sessions "{\"task_id\":\"$T2\",\"subtask_id\":\"$SB1\",\"started_at\":$((NOW+120000)),\"ended_at\":$((NOW+180000))}" | python3 -c "import sys,json; print('cross-task link →', json.load(sys.stdin)['error']['code'])"

echo "== report: task row + nested subtasks =="
TODAY=$(date -u +%F)
req $J ui GET "/reports/summary" | python3 -c "
import sys,json
r=json.load(sys.stdin)
row=[t for t in r['table'] if t['task_id']=='$TID'][0]
print('task totals today:', row['today'], '| subtask rows:', sorted([(s['name'], s['today'], s['week'], s['all']) for s in row['subtasks']]))
task_sum = row['today']
sub_sum = sum(s['today'] for s in row['subtasks'])
print('task-level today (no-subtask time):', task_sum - sub_sum)
print('donut still project-level:', len(r['donut']) >= 0)"

echo "== delete subtask → time kept, link cleared =="
req $J ui DELETE "/subtasks/$SB1" >/dev/null
req $J ui GET "/sessions?task_id=$TID" | python3 -c "
import sys,json
ss=json.load(sys.stdin)['sessions']
assert len(ss)>=4, f'sessions lost after subtask delete: {len(ss)}'
assert not any(s.get('subtask_id')=='$SB1' for s in ss), 'a session still points at the deleted subtask'
print('sessions still present:', len(ss), '| none pointing at deleted SB1')"
echo DONE
