#!/bin/bash
# TimeKeep Web — social layer end-to-end test (phases 1–4) against `wrangler dev`.
# Run `smoke-test.sh` first — this script creates its own admin-session and users
# but reuses nothing else. Covers: friend requests by username, project
# visibility + live presence, groups (username invites + token links),
# fine-grained member permissions, group chat, group projects + group report.
#
# Env overrides: ADMIN_USERNAME / ADMIN_PASSWORD (defaults like smoke-test.sh).
set -e
BASE=http://127.0.0.1:8787/api
ORIGIN=http://127.0.0.1:8787
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-purple-marmalade-admin-42}"
SFX=$$   # unique-per-run usernames so reruns never collide
JA=/tmp/tk-soc-a.txt; JB=/tmp/tk-soc-b.txt; JC=/tmp/tk-soc-c.txt; JADM=/tmp/tk-soc-adm.txt
rm -f $JA $JB $JC $JADM
UA="soc-a$SFX"; UB="soc-b$SFX"; UC="soc-c$SFX"
PASS='a-very-long-password-123'

# req JAR DEVICE METHOD PATH [JSON] — cookie-jar aware, auto CSRF header,
# retries transient local-dev drops (see smoke-test.sh)
req() {
  local jar=$1 dev=$2 method=$3 path=$4 data=$5
  local t out rc=1 a
  for a in 1 2 3 4 5; do
    t=$(grep tk_csrf "$jar" 2>/dev/null | awk '{print $NF}')
    if [ -n "$data" ]; then
      out=$(curl -s --max-time 20 -b "$jar" -c "$jar" -X "$method" "$BASE$path" \
        -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-device-id: $dev" \
        -H "x-csrf-token: $t" -d "$data")
    else
      out=$(curl -s --max-time 20 -b "$jar" -c "$jar" -X "$method" "$BASE$path" \
        -H "origin: $ORIGIN" -H "x-device-id: $dev" -H "x-csrf-token: $t")
    fi
    rc=$?
    [ $rc -eq 0 ] && [ -n "$out" ] && break
    sleep 2
  done
  echo "$out"
}

# settle — the local proxy intermittently drops the request right after a DO
# fan-out (accept/join); a short pause keeps the script off that edge
settle() { sleep 2; }

new_user() { # jar dev username — admin-created + first-login password change
  local jar=$1 dev=$2 uname=$3
  req $JADM dev-adm POST /admin/users "{\"username\":\"$uname\",\"password\":\"$PASS\"}" >/dev/null
  req $jar $dev POST /auth/login "{\"identifier\":\"$uname\",\"password\":\"$PASS\"}" >/dev/null
  req $jar $dev POST /me/password "{\"current_password\":\"$PASS\",\"password\":\"$PASS-working-42\"}" >/dev/null
}

echo "== setup: users A (owner), B, C =="
req $JADM dev-adm POST /auth/login "{\"identifier\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" >/dev/null
new_user $JA dev-a "$UA"; new_user $JB dev-b "$UB"; new_user $JC dev-c "$UC"
echo "users ok"

# ---------- phase 1: friends ----------
echo "== friends: request by username, duplicate 409, accept, both lists =="
RID=$(req $JA dev-a POST /friends/requests "{\"username\":\"$UB\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['request']['id'])")
req $JA dev-a POST /friends/requests "{\"username\":\"$UB\"}" | grep -q already_requested
req $JB dev-b POST "/friends/requests/$RID/accept" | grep -q '"accepted":true'
req $JA dev-a GET /friends | grep -q "\"username\":\"$UB\""
req $JB dev-b GET /friends | grep -q "\"username\":\"$UA\""
echo "ok"

echo "== username lookup returns the profile triple only =="
req $JA dev-a GET "/users/lookup?username=$UB" | grep -q '"username"'
echo "ok"

# ---------- phase 1: visibility + presence ----------
echo "== visibility: A shares a project; B sees structure, not the private one =="
P2ID=$(req $JA dev-a POST /projects '{"name":"Shared running"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
req $JA dev-a POST "/projects/$P2ID/tasks" '{"name":"Morning run"}' >/dev/null
req $JA dev-a PATCH "/projects/$P2ID" '{"visibility":"friends"}' | grep -q '"visibility":"friends"'
AID=$(req $JA dev-a GET /me | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
req $JB dev-b GET "/friends/$AID/projects" | grep -q '"Shared running"'
req $JB dev-b GET "/friends/$AID/projects/$P2ID" | grep -q '"Morning run"'
P1ID=$(req $JA dev-a POST /projects '{"name":"Private stuff"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
req $JB dev-b GET "/friends/$AID/projects/$P1ID" | grep -q not_found
echo "ok"

echo "== presence: A tracks on the shared task → B sees it; stop clears it =="
TID=$(req $JA dev-a GET /bootstrap | python3 -c "import sys,json; b=json.load(sys.stdin); print([t['id'] for t in b['tasks'] if t['project_id']=='$P2ID'][0])")
req $JA dev-a POST /timer/start "{\"task_id\":\"$TID\"}" >/dev/null
settle
req $JB dev-b POST /friends/presence "{\"ids\":[\"$AID\"]}" | grep -q '"task_name":"Morning run"'
LAST=$(req $JB dev-b GET /bootstrap | python3 -c "import sys,json; print(json.load(sys.stdin)['last_event_id'])")
req $JB dev-b GET "/sync?since=$((LAST-3))" | grep -q 'friend.timer'
req $JA dev-a POST /timer/stop >/dev/null
settle
req $JB dev-b POST /friends/presence "{\"ids\":[\"$AID\"]}" | grep -q "\"$AID\":null"
echo "ok"

# ---------- phase 2: groups + invites + permissions ----------
echo "== groups: create, username invite → B, link invite → C =="
GID=$(req $JA dev-a POST /groups '{"name":"Launch team"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['group']['id'])")
IINV=$(req $JA dev-a POST "/groups/$GID/invites" "{\"username\":\"$UB\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['invite']['id'])")
req $JB dev-b POST "/groups/invites/$IINV/accept" | grep -q '"name":"Launch team"'
settle
TOKEN=$(req $JA dev-a POST "/groups/$GID/links" '{"expires_in_days":7,"max_uses":5}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
settle
req $JC dev-c GET "/groups/join/preview?token=$TOKEN" | grep -q '"Launch team"'
req $JC dev-c POST /groups/join "{\"token\":\"$TOKEN\"}" | grep -q '"Launch team"'
req $JC dev-c POST /groups/join "{\"token\":\"$TOKEN\"}" | grep -q already_member
LID=$(req $JA dev-a GET "/groups/$GID/links" | python3 -c "import sys,json; print(json.load(sys.stdin)['links'][0]['id'])")
req $JA dev-a DELETE "/groups/$GID/links/$LID" >/dev/null
req $JC dev-c POST /groups/join "{\"token\":\"$TOKEN\"}" | grep -q not_found
echo "ok"

echo "== permissions: B (admin, only edit_group) — invite 403, rename ok, role mgmt 403 =="
BID=$(req $JA dev-a GET "/groups/$GID" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['id'] for m in d['members'] if m['role']!='owner'][0])")
req $JA dev-a PATCH "/groups/$GID/members/$BID" '{"role":"admin","perms":["edit_group"]}' >/dev/null
req $JB dev-b POST "/groups/$GID/invites" "{\"username\":\"$UC\"}" | grep -q forbidden
req $JB dev-b PATCH "/groups/$GID" '{"name":"Launch team v2"}' | grep -q '"Launch team v2"'
CID=$(req $JA dev-a GET "/groups/$GID" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['id'] for m in d['members'] if m['role']=='member'][0])")
req $JB dev-b PATCH "/groups/$GID/members/$CID" '{"role":"admin"}' | grep -q forbidden
req $JB dev-b DELETE "/groups/$GID/members/$CID" | grep -q forbidden
req $JA dev-a POST "/groups/$GID/leave" | grep -q owner_cannot_leave
echo "ok"

# ---------- phase 3: chat ----------
echo "== chat: B sends, A receives via sync; edit rules; moderation; unread =="
MID=$(req $JB dev-b POST "/groups/$GID/messages" '{"body":"hello team"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['id'])")
LASTA=$(req $JA dev-a GET /bootstrap | python3 -c "import sys,json; print(json.load(sys.stdin)['last_event_id'])")
req $JA dev-a GET "/sync?since=$((LASTA-2))" | grep -q 'group.message_created'
req $JB dev-b PATCH "/groups/$GID/messages/$MID" '{"body":"hello team (edited)"}' | grep -q '(edited)'
req $JC dev-c PATCH "/groups/$GID/messages/$MID" '{"body":"hijack"}' | grep -q forbidden
python3 -c "print('{\"body\": \"' + 'x'*2001 + '\"}')" > /tmp/tk-soc-long.json
req $JB dev-b POST "/groups/$GID/messages" "$(cat /tmp/tk-soc-long.json)" | grep -q validation
req $JB dev-b POST "/groups/$GID/messages" '{"body":"second"}' >/dev/null
req $JA dev-a GET /groups | python3 -c "import sys,json; g=[g for g in json.load(sys.stdin)['groups'] if g['id']=='$GID'][0]; assert g['unread']==2, g['unread']"
req $JA dev-a POST "/groups/$GID/read" >/dev/null
req $JA dev-a GET /groups | python3 -c "import sys,json; g=[g for g in json.load(sys.stdin)['groups'] if g['id']=='$GID'][0]; assert g['unread']==0"
req $JA dev-a DELETE "/groups/$GID/messages/$MID" >/dev/null
req $JA dev-a GET "/groups/$GID/messages" | python3 -c "
import sys,json
m=[x for x in json.load(sys.stdin)['messages'] if x['id']=='$MID'][0]
assert m['deleted_at'] is not None and m['body']==''"
echo "ok"

# ---------- phase 4: group projects ----------
echo "== group projects: members see it; edit_tasks gates; dual tracking; report =="
PID=$(req $JA dev-a POST "/groups/$GID/projects" '{"name":"Sprint 1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['project']['id'])")
for j in "$JA:a" "$JB:b" "$JC:c"; do
  jar=${j%%:*}; dev=${j##*:}
  req $jar dev-$dev GET /projects | python3 -c "
import sys,json
ps=[p for p in json.load(sys.stdin)['projects'] if p['id']=='$PID']
assert ps and ps[0]['group_id']=='$GID'"
done
GTID=$(req $JA dev-a POST "/projects/$PID/tasks" '{"name":"Build the thing"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")
req $JC dev-c POST "/projects/$PID/tasks" '{"name":"nope"}' | grep -q forbidden
req $JB dev-b POST /timer/start "{\"task_id\":\"$GTID\"}" >/dev/null
req $JA dev-a POST /timer/start "{\"task_id\":\"$GTID\"}" >/dev/null   # simultaneous — per-user invariant
req $JA dev-a POST /timer/stop >/dev/null
req $JB dev-b POST /timer/stop >/dev/null
settle
req $JA dev-a GET "/groups/$GID/report" | python3 -c "
import sys,json
r=json.load(sys.stdin)
assert any(m['username']=='$UB' for m in r['members']), r['members']"
req $JA dev-a PATCH "/projects/$PID" '{"visibility":"friends"}' | grep -q validation
req $JC dev-c DELETE "/projects/$PID" | grep -q forbidden
req $JA dev-a DELETE "/projects/$PID" >/dev/null
req $JB dev-b GET /projects | python3 -c "
import sys,json
assert not any(p['id']=='$PID' for p in json.load(sys.stdin)['projects'])"
echo "ok"

# ---------- membership revocation ----------
echo "== kick C → immediate access loss =="
settle
req $JA dev-a DELETE "/groups/$GID/members/$CID" >/dev/null
req $JC dev-c GET "/groups/$GID" | grep -q not_found
echo "ok"

echo "SOCIAL E2E PASSED"
