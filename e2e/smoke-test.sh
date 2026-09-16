#!/bin/bash
# TimeKeep Web — end-to-end API smoke test against `wrangler dev` (local D1 + DO).
# Accounts are admin-managed (no self-signup): the script logs in as the seeded
# admin, creates two users, then exercises the API as a normal user.
#
# Env overrides: ADMIN_USERNAME (default "admin"), ADMIN_PASSWORD (default
# "purple-marmalade-admin-42"). On first run the script changes the seeded
# default password ("changemeasap") to ADMIN_PASSWORD; later runs reuse it.
set -e
BASE=http://127.0.0.1:8787/api
ORIGIN=http://127.0.0.1:8787
JAR_A=/tmp/tk-admin.txt
JAR=/tmp/tk-cookies.txt
JAR2=/tmp/tk2.txt
rm -f $JAR_A $JAR $JAR2
DEV_A=device-admin
DEV=device-test-1
DEV2=device-2
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-purple-marmalade-admin-42}"

# req JAR DEVICE METHOD PATH [JSON] — cookie-jar aware, auto CSRF header,
# retries transient local-dev drops (empty responses from `wrangler dev`'s
# DO proxy are connection-level curl errors; HTTP errors are never retried)
req() {
  local jar=$1 dev=$2 method=$3 path=$4 data=$5
  local t; t=$(grep tk_csrf "$jar" 2>/dev/null | awk '{print $NF}')
  local out rc=1 a
  for a in 1 2 3; do
    if [ -n "$data" ]; then
      out=$(curl -s -b "$jar" -c "$jar" -X "$method" "$BASE$path" -H "content-type: application/json" \
        -H "origin: $ORIGIN" -H "x-device-id: $dev" -H "x-csrf-token: $t" -d "$data")
    else
      out=$(curl -s -b "$jar" -c "$jar" -X "$method" "$BASE$path" \
        -H "origin: $ORIGIN" -H "x-device-id: $dev" -H "x-csrf-token: $t")
    fi
    rc=$?
    [ $rc -eq 0 ] && break
    sleep 1
  done
  echo "$out"
}

echo "== no self-signup: /auth/signup must 404 =="
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/auth/signup -H "content-type: application/json" \
  -d '{"username":"x","password":"not-gonna-work-123"}'

echo "== admin login (seeded account; first run replaces the default password) =="
LOGIN=$(curl -s -c $JAR_A -X POST $BASE/auth/login -H "content-type: application/json" \
  -d "{\"identifier\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")
if ! echo "$LOGIN" | grep -q '"ok":true'; then
  # first run: sign in with the seeded default ("changemeasap", forced change)
  # and set ADMIN_PASSWORD for this and future runs
  LOGIN=$(curl -s -c $JAR_A -X POST $BASE/auth/login -H "content-type: application/json" \
    -d '{"identifier":"admin","password":"changemeasap"}')
  echo "$LOGIN" | grep -q '"must_change_password":true' || { echo "FAIL admin login: $LOGIN"; exit 1; }
  T=$(grep tk_csrf $JAR_A | awk '{print $NF}')
  CH=$(curl -s -b $JAR_A -c $JAR_A -X POST $BASE/me/password -H "content-type: application/json" \
    -H "x-csrf-token: $T" -d "{\"current_password\":\"changemeasap\",\"password\":\"$ADMIN_PASSWORD\"}")
  echo "$CH" | grep -q '"ok":true' || { echo "FAIL admin password change: $CH"; exit 1; }
  LOGIN=$(curl -s -c $JAR_A -X POST $BASE/auth/login -H "content-type: application/json" \
    -d "{\"identifier\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")
  echo "$LOGIN" | grep -q '"ok":true' || { echo "FAIL admin re-login: $LOGIN"; exit 1; }
fi
echo "admin ok: $(echo "$LOGIN" | head -c 140)"

echo "== admin user management =="
# ensure_user USERNAME PAYLOAD TEMP_PASSWORD — create the user; on conflict
# (leftover from a previous run) reset it to the temp password + forced change,
# which restores the exact fresh-creation state
ensure_user() {
  local r
  r=$(req $JAR_A $DEV_A POST /admin/users "$2")
  if ! echo "$r" | grep -q '"username"'; then
    local uid
    uid=$(req $JAR_A $DEV_A GET /admin/users | python3 -c "import json,sys; print([u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='$1'][0])")
    req $JAR_A $DEV_A POST /admin/users/$uid/password "{\"password\":\"$3\"}" > /dev/null
    r="{\"username\":\"$1\",\"reset\":true}"
  fi
  echo "$r"
}
R=$(ensure_user dana '{"username":"dana","name":"Dana","email":"dana@example.com","password":"initial-dana-pass-42"}' 'initial-dana-pass-42')
echo "$R" | grep -q '"username":"dana"' || { echo "FAIL ensure dana: $R"; exit 1; }
R=$(ensure_user milan '{"username":"milan","name":"Milan","password":"initial-milan-pass-42"}' 'initial-milan-pass-42')
echo "$R" | grep -q '"username":"milan"' || { echo "FAIL ensure milan: $R"; exit 1; }
echo "-- duplicate username must 409:"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR_A -X POST $BASE/admin/users -H "content-type: application/json" \
  -H "origin: $ORIGIN" -H "x-device-id: $DEV_A" -H "x-csrf-token: $(grep tk_csrf $JAR_A | awk '{print $NF}')" \
  -d '{"username":"dana","password":"some-other-pass-42"}'
echo "-- admin cannot deactivate the admin account (422):"
AID=$(req $JAR_A $DEV_A GET /admin/users | python3 -c "import json,sys; print([u['id'] for u in json.load(sys.stdin)['users'] if u['role']=='admin'][0])")
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR_A -X PATCH $BASE/admin/users/$AID -H "content-type: application/json" \
  -H "origin: $ORIGIN" -H "x-device-id: $DEV_A" -H "x-csrf-token: $(grep tk_csrf $JAR_A | awk '{print $NF}')" \
  -d '{"active":0}'

echo "== dana login → forced password change gates everything =="
curl -s -c $JAR -X POST $BASE/auth/login -H "content-type: application/json" \
  -d '{"identifier":"dana","password":"initial-dana-pass-42"}' | grep -q '"must_change_password":true' || { echo "FAIL dana flag"; exit 1; }
echo "-- bootstrap while flagged must 403:"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR $BASE/bootstrap -H "x-device-id: $DEV"
echo "-- /me stays readable (flag surfaced):"
curl -s -b $JAR $BASE/me -H "x-device-id: $DEV" | python3 -c "import json,sys; u=json.load(sys.stdin)['user']; print(u['username'], u['role'], 'flagged:', u['must_change_password'])"
T=$(grep tk_csrf $JAR | awk '{print $NF}')
CH=$(curl -s -b $JAR -c $JAR -X POST $BASE/me/password -H "content-type: application/json" \
  -H "origin: $ORIGIN" -H "x-csrf-token: $T" -H "x-device-id: $DEV" \
  -d '{"current_password":"initial-dana-pass-42","password":"purple-marmalade-tuesday"}')
echo "$CH" | grep -q '"ok":true' || { echo "FAIL dana password change: $CH"; exit 1; }

echo "== admin surface blocked for non-admins (dana) =="
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR $BASE/admin/users -H "x-device-id: $DEV"

echo "== bootstrap =="
BOOT=$(req $JAR $DEV GET /bootstrap)
echo "$BOOT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('user:', d['user']['username'], '| tz:', d['user']['timezone'], '| projects:', len(d['projects']))"

echo "== create project =="
PID=$(req $JAR $DEV POST /projects "{\"name\":\"Client A $(date +%s)\",\"color\":\"#22c55e\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])")
echo "project: $PID"

echo "== create 3 tasks =="
T1=$(req $JAR $DEV POST /projects/$PID/tasks '{"name":"Design"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['id'])")
T2=$(req $JAR $DEV POST /projects/$PID/tasks '{"name":"Build"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['id'])")
T3=$(req $JAR $DEV POST /projects/$PID/tasks '{"name":"Ship"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['id'])")
echo "tasks: $T1 $T2 $T3"

echo "== subtasks =="
req $JAR $DEV POST /tasks/$T1/subtasks '{"name":"Sketch wireframes"}' | head -c 200; echo
SB=$(req $JAR $DEV POST /tasks/$T1/subtasks '{"name":"Review with client"}')
SBID=$(echo "$SB" | python3 -c "import json,sys; print(json.load(sys.stdin)['subtask']['id'])")
req $JAR $DEV PATCH /subtasks/$SBID '{"done":true}' | python3 -c "import json,sys; print('toggled done:', json.load(sys.stdin)['subtask']['done'])"

echo "== two-level enforcement (FR-T3): subtask under subtask must fail =="
req $JAR $DEV POST /tasks/$SBID/subtasks '{"name":"nope"}' | head -c 160; echo

echo "== dependencies: Build depends on Design, Ship on Build, then cycle attempt (FR-M4) =="
req $JAR $DEV POST /tasks/$T2/deps "{\"depends_on_id\":\"$T1\"}" | head -c 120; echo
req $JAR $DEV POST /tasks/$T3/deps "{\"depends_on_id\":\"$T2\"}" | head -c 120; echo
req $JAR $DEV POST /tasks/$T1/deps "{\"depends_on_id\":\"$T3\"}" | head -c 300; echo

echo "== timer start (server-authoritative via DO) =="
TIMER=$(req $JAR $DEV POST /timer/start "{\"task_id\":\"$T2\"}")
echo "$TIMER" | head -c 220; echo
echo "== second start must 409 (single-timer invariant) =="
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR -X POST $BASE/timer/start -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $DEV" -H "x-csrf-token: $(grep tk_csrf $JAR | awk '{print $NF}')" -d "{\"task_id\":\"$T1\"}"
echo "== switch to Design (FR-S1 atomic switch) =="
req $JAR $DEV POST /timer/switch "{\"task_id\":\"$T1\"}" | head -c 260; echo
echo "== timer state =="
req $JAR $DEV GET /timer | python3 -c "import json,sys; d=json.load(sys.stdin); print('running task_id:', d['session']['task_id'] if d.get('session') else None, '| pomo phase:', d['pomo']['phase'] if d.get('pomo') else None)"
echo "== stop =="
req $JAR $DEV POST /timer/stop | python3 -c "import json,sys; d=json.load(sys.stdin); s=d['session']; print('finalized:', s['ended_at'] is not None and s['ended_at'] > s['started_at'])"

echo "== manual session + overlap rejection (FR-S4) =="
# the account is seconds old (rule: started_at >= account.created_at), so use
# future-tolerant ranges within the allowed now+5min window (spec §5.5.4)
NOW=$(($(date +%s) * 1000))
curl -s -o /dev/null -w "%{http_code} " -b $JAR -X POST $BASE/sessions -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $DEV" -H "x-csrf-token: $(grep tk_csrf $JAR | awk '{print $NF}')" \
  -d "{\"task_id\":\"$T3\",\"started_at\":$((NOW + 30000)),\"ended_at\":$((NOW + 90000)),\"note\":\"deep work\"}"
req $JAR $DEV POST /sessions "{\"task_id\":\"$T3\",\"started_at\":$((NOW + 30000)),\"ended_at\":$((NOW + 90000)),\"note\":\"deep work\"}" | head -c 100; echo
echo "-- duplicate insert (same task, same range) must 409 overlap:"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR -X POST $BASE/sessions -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $DEV" -H "x-csrf-token: $(grep tk_csrf $JAR | awk '{print $NF}')" \
  -d "{\"task_id\":\"$T3\",\"started_at\":$((NOW + 60000)),\"ended_at\":$((NOW + 120000))}"
echo "-- same range, different task (allowed):"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR -X POST $BASE/sessions -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $DEV" -H "x-csrf-token: $(grep tk_csrf $JAR | awk '{print $NF}')" \
  -d "{\"task_id\":\"$T1\",\"started_at\":$((NOW + 60000)),\"ended_at\":$((NOW + 120000))}"

echo "== reports summary (Tehran bucketing, running included) =="
req $JAR $DEV GET "/reports/summary?from=2026-01-01&to=2026-12-31" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('day buckets:', len(d['days']), '| donut rows:', len(d['donut']), '| table rows:', len(d['table']))
print('totals: today', d['totals']['today'], 'week', d['totals']['week'], 'all', d['totals']['all'])
"
echo "== heatmap =="
req $JAR $DEV GET "/reports/heatmap?year=2026" | python3 -c "import json,sys; d=json.load(sys.stdin); print('heatmap days with time:', len(d['days']))"

echo "== sync log events =="
req $JAR $DEV GET "/sync?since=0" | python3 -c "import json,sys; d=json.load(sys.stdin); print('events:', len(d['events']), '| types:', sorted(set(e['type'] for e in d['events']))[:8])"

echo "== export round-trip (FR-D1) =="
curl -s -b $JAR "$BASE/export?format=json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('schema:', d['schema_version'], '| projects:', len(d['projects']), '| tasks:', len(d['tasks']), '| sessions:', len(d['sessions']), '| deps:', len(d['dependencies']))
"

echo "== authz isolation (NFR-3 AC): milan cannot mutate dana's project =="
curl -s -c $JAR2 -X POST $BASE/auth/login -H "content-type: application/json" \
  -d '{"identifier":"milan","password":"initial-milan-pass-42"}' | grep -q '"must_change_password":true'
T2=$(grep tk_csrf $JAR2 | awk '{print $NF}')
curl -s -b $JAR2 -c $JAR2 -o /dev/null -X POST $BASE/me/password -H "content-type: application/json" \
  -H "x-csrf-token: $T2" -d '{"current_password":"initial-milan-pass-42","password":"another-secure-passphrase-42"}'
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR2 "$BASE/projects/$PID" -X PATCH -H "content-type: application/json" \
  -H "origin: $ORIGIN" -H "x-device-id: $DEV2" -H "x-csrf-token: $(grep tk_csrf $JAR2 | awk '{print $NF}')" -d '{"name":"hacked"}'

echo "== CSRF guard: state-changing request with foreign Origin =="
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR -X PATCH $BASE/projects/$PID -H "content-type: application/json" -H "origin: https://evil.example" -H "x-device-id: $DEV" -d '{"name":"evil"}'

echo "== admin deactivates milan → signed out + login blocked (data kept) =="
MID=$(req $JAR_A $DEV_A GET /admin/users | python3 -c "import json,sys; print([u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='milan'][0])")
req $JAR_A $DEV_A PATCH /admin/users/$MID '{"active":0}' > /dev/null
echo "-- milan's live session revoked:"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR2 $BASE/me -H "x-device-id: $DEV2"
echo "-- milan login → 403 account_disabled:"
curl -s -X POST $BASE/auth/login -H "content-type: application/json" \
  -d '{"identifier":"milan","password":"another-secure-passphrase-42"}' | grep -q 'account_disabled' \
  && echo "blocked ✓"
echo "-- reactivate:"
req $JAR_A $DEV_A PATCH /admin/users/$MID '{"active":1}' > /dev/null

echo "== admin resets dana's password → sessions revoked + forced change =="
DID=$(req $JAR_A $DEV_A GET /admin/users | python3 -c "import json,sys; print([u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='dana'][0])")
req $JAR_A $DEV_A POST /admin/users/$DID/password '{"password":"temporary-dana-pass-7"}' > /dev/null
echo "-- dana's old session revoked:"
curl -s -o /dev/null -w "%{http_code}\n" -b $JAR $BASE/me -H "x-device-id: $DEV"
echo "-- temp password works, flag set, change it back:"
curl -s -c $JAR -X POST $BASE/auth/login -H "content-type: application/json" \
  -d '{"identifier":"dana","password":"temporary-dana-pass-7"}' | grep -q '"must_change_password":true'
T=$(grep tk_csrf $JAR | awk '{print $NF}')
curl -s -b $JAR -c $JAR -o /dev/null -X POST $BASE/me/password -H "content-type: application/json" \
  -H "x-csrf-token: $T" -d '{"current_password":"temporary-dana-pass-7","password":"purple-marmalade-tuesday"}'

echo "== rate limiting (login 10/15min per identifier) =="
for i in $(seq 1 11); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST $BASE/auth/login -H "content-type: application/json" -d '{"identifier":"nobody@example.com","password":"wrong-password-123"}')
  printf "%s " "$CODE"
done
echo

echo "SMOKE TEST COMPLETE"
