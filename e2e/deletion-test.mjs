// Audit F1/F2/F8: destructive deletion paths must never destroy other people's
// history, and account deletion must actually WORK.
//
//   F1  — `DELETE /me` misses `goals`, `groups.owner_id`, `group_invites.invited_by`
//         and `group_invite_links.created_by` (no ON DELETE action), so any user who
//         has a goal, owns a group, or sent an invite/link cannot delete their
//         account at all (the atomic batch 500s and nothing is removed).
//   F2  — `DELETE /groups/:id` cascade-destroys every member's sessions through
//         projects.group_id → tasks.project_id → time_sessions.task_id (all
//         ON DELETE CASCADE), and so does `DELETE /me` when the deleted user
//         created shared group projects/tasks. The tombstone path (INV-06) never runs.
//   F8  — `group.deleted` is emitted AFTER the members are gone, so nobody is told.
//   D1  — (owner decision) an owned group with remaining members is handed to the
//         earliest-joined active member on account deletion, and the deleting user's
//         shared rows are reassigned to the new owner.
//
// Runs against `wrangler dev` like the rest of the suite.
import { withProxyRetry } from './support/proxy-retry.mjs';

const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787/api';
const ORIGIN = new URL(BASE).origin;
const WS_BASE = (process.env.TK_BASE ?? 'http://127.0.0.1:8787').replace(/^http/, 'ws');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42';
const SEEDED_PASSWORD = 'changemeasap';
const PASS = 'a-very-long-deletion-pass-1';

let fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail = 1;
}

const callOnce = async (jar, method, path, data) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      origin: ORIGIN,
      'x-device-id': jar.device ?? 'dele',
      'x-csrf-token': jar.csrf ?? '',
      ...(jar.cookies?.length ? { cookie: jar.cookies.join('; ') } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    if (name === 'tk_csrf') jar.csrf = pair.slice(eq + 1);
    jar.cookies = (jar.cookies ?? []).filter((p) => !p.startsWith(`${name}=`));
    jar.cookies.push(`${name}=${pair.slice(eq + 1)}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
};

async function call(jar, method, path, data) {
  // `wrangler dev` drops requests under load; retry so the script dies on the
  // deletion behaviour, not on the proxy flake
  return withProxyRetry(`${method} ${path}`, () => callOnce(jar, method, path, data));
}

async function makeUser(admin, name) {
  const created = await call(admin, 'POST', '/admin/users', { username: name, password: PASS });
  if (created.status !== 201)
    throw new Error(`could not create ${name}: ${created.status} ${JSON.stringify(created.body)}`);
  const jar = { cookies: [] };
  await call(jar, 'POST', '/auth/login', { identifier: name, password: PASS });
  const changed = await call(jar, 'POST', '/me/password', { current_password: PASS, password: `${PASS}-work` });
  if (changed.status !== 200) throw new Error(`could not clear the password gate for ${name}`);
  return { jar, name };
}

/** The reported minutes for a task, from the summary table. */
async function minsFor(jar, taskId) {
  const res = await call(jar, 'GET', '/reports/summary');
  if (res.status !== 200) throw new Error(`summary failed: ${res.status} ${JSON.stringify(res.body)}`);
  const row = (res.body?.table ?? []).find((r) => r.task_id === taskId);
  if (!row) return null;
  return Number(row.all ?? 0);
}

async function main() {
  const admin = { cookies: [] };
  let li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD });
  if (li.status !== 200) {
    li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: SEEDED_PASSWORD });
    if (li.status === 200 && li.body?.must_change_password) {
      const rot = await call(admin, 'POST', '/me/password', {
        current_password: SEEDED_PASSWORD,
        password: ADMIN_PASSWORD,
      });
      if (rot.status !== 200) throw new Error('admin password change failed');
      li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD });
    }
  }
  if (li.status !== 200) {
    console.error(`deletion test: admin login failed (${li.status}) — run smoke-test.sh first`);
    process.exit(1);
  }

  const stamp = Date.now().toString(36).slice(-6);
  const a = await makeUser(admin, `da${stamp}`); // owner in scenarios B/C
  const b = await makeUser(admin, `db${stamp}`); // the member whose history must survive
  const c = await makeUser(admin, `dc${stamp}`); // the F1 "hoarder" (goal/group/invites)

  // sessions are validated against the account's own created_at — start the
  // shared 60s window after BOTH accounts existed (see tombstone-test.mjs)
  const [meA, meB] = [await call(a.jar, 'GET', '/me'), await call(b.jar, 'GET', '/me')];
  const base = Math.max(meA.body?.user?.created_at ?? 0, meB.body?.user?.created_at ?? 0) + 1000;
  const start = base;
  const end = start + 60_000;

  // ============ scenario A (F1): account deletion with entanglements ============
  console.log('\n== F1: account with goal / owned group / invite / link ==');
  const projC = await call(c.jar, 'POST', '/projects', { name: `del-proj-${stamp}` });
  const pidC = projC.body?.project?.id;
  const goalC = await call(c.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 10,
    scope: [`project:${pidC}`],
  });
  check('goal created', goalC.status === 201, `status ${goalC.status} ${JSON.stringify(goalC.body)}`);
  const gC = await call(c.jar, 'POST', '/groups', { name: `del-group-${stamp}` });
  const gidC = gC.body?.group?.id;
  check('group created', !!gidC, `status ${gC.status}`);
  const invC = await call(c.jar, 'POST', `/groups/${gidC}/invites`, { username: b.name });
  check('invite sent', invC.status === 201, `status ${invC.status}`);
  const linkC = await call(c.jar, 'POST', `/groups/${gidC}/links`, {});
  check('invite link minted', linkC.status === 201, `status ${linkC.status}`);

  const delC = await call(c.jar, 'DELETE', '/me');
  check(
    'account with goal/group/invite/link can be deleted (F1)',
    delC.status === 200,
    `status ${delC.status} ${JSON.stringify(delC.body)}`,
  );
  const reloginC = await call({ cookies: [] }, 'POST', '/auth/login', {
    identifier: c.name,
    password: `${PASS}-work`,
  });
  check('the deleted account can no longer log in', reloginC.status === 401, `status ${reloginC.status}`);

  // ====== scenario B (F2 + F8): group delete must preserve member history ======
  console.log('\n== F2/F8: group deletion ==');
  const g1 = await call(a.jar, 'POST', '/groups', { name: `delg1-${stamp}` });
  const gid1 = g1.body?.group?.id;
  const inv1 = await call(a.jar, 'POST', `/groups/${gid1}/invites`, { username: b.name });
  await call(b.jar, 'POST', `/groups/invites/${inv1.body?.invite?.id}/accept`, {});
  const p1 = await call(a.jar, 'POST', `/groups/${gid1}/projects`, { name: `delg1-proj-${stamp}` });
  const pid1 = p1.body?.project?.id;
  const t1 = await call(a.jar, 'POST', `/projects/${pid1}/tasks`, { name: 'shared work' });
  const tid1 = t1.body?.task?.id;
  const aS1 = await call(a.jar, 'POST', '/sessions', { task_id: tid1, started_at: start, ended_at: end });
  const bS1 = await call(b.jar, 'POST', '/sessions', { task_id: tid1, started_at: start, ended_at: end });
  check(
    'both members logged time on the shared task',
    aS1.status === 201 && bS1.status === 201,
    `A ${aS1.status} / B ${bS1.status}`,
  );
  const beforeB1 = await minsFor(b.jar, tid1);
  check('B has time on the shared task before the delete', beforeB1 > 0, `${beforeB1} min`);

  // B watches the socket while the owner deletes the group. The collector is
  // attached BEFORE the delete — the broadcast can land in the gap between
  // the DELETE response and a late onmessage assignment.
  const ws = new WebSocket(`${WS_BASE}/api/ws?device=deleB`, { headers: { cookie: b.jar.cookies.join('; ') } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('ws error'));
    };
  });
  const wsTypes = [];
  ws.onmessage = (m) => {
    try {
      wsTypes.push(JSON.parse(m.data)?.type);
    } catch {
      /* non-JSON frame */
    }
  };

  const delG = await call(a.jar, 'DELETE', `/groups/${gid1}`);
  check('group deletion succeeds', delG.status === 200, `status ${delG.status} ${JSON.stringify(delG.body)}`);
  await new Promise((r) => setTimeout(r, 1000));
  ws.close();
  check(
    'the remaining member receives group.deleted (F8)',
    wsTypes.includes('group.deleted'),
    `received: ${wsTypes.join(',') || 'nothing'}`,
  );
  const syncB = await call(b.jar, 'GET', '/sync?since=0');
  check(
    "group.deleted is in the surviving member's sync log",
    (syncB.body?.events ?? []).some((e) => e.type === 'group.deleted'),
    `status ${syncB.status}, ${syncB.body?.events?.length ?? 0} events`,
  );

  const afterB1 = await minsFor(b.jar, tid1);
  check(
    "B's time survived the group's deletion (F2)",
    afterB1 === beforeB1 && afterB1 > 0,
    `${beforeB1} min → ${afterB1} min`,
  );
  const logB = await call(b.jar, 'GET', `/sessions?task_id=${tid1}`);
  check(
    'the log still lists the session',
    (logB.body?.sessions ?? []).length >= 1,
    `${logB.body?.sessions?.length ?? 0} rows`,
  );
  const afterA1 = await minsFor(a.jar, tid1);
  check("A's own time survived too", afterA1 > 0, `${afterA1} min`);

  // ==== scenario C (F2): the shared-row creator deletes their ACCOUNT ====
  console.log('\n== F2: creator account deletion ==');
  const g2 = await call(a.jar, 'POST', '/groups', { name: `delg2-${stamp}` });
  const gid2 = g2.body?.group?.id;
  const inv2 = await call(a.jar, 'POST', `/groups/${gid2}/invites`, { username: b.name });
  await call(b.jar, 'POST', `/groups/invites/${inv2.body?.invite?.id}/accept`, {});
  const p2 = await call(a.jar, 'POST', `/groups/${gid2}/projects`, { name: `delg2-proj-${stamp}` });
  const pid2 = p2.body?.project?.id;
  const t2 = await call(a.jar, 'POST', `/projects/${pid2}/tasks`, { name: 'second shared work' });
  const tid2 = t2.body?.task?.id;
  const aS2 = await call(a.jar, 'POST', '/sessions', { task_id: tid2, started_at: start, ended_at: end });
  const bS2 = await call(b.jar, 'POST', '/sessions', { task_id: tid2, started_at: start, ended_at: end });
  check(
    'both members logged time on the second shared task',
    aS2.status === 201 && bS2.status === 201,
    `A ${aS2.status} / B ${bS2.status}`,
  );
  const beforeB2 = await minsFor(b.jar, tid2);
  check('B has time on the second shared task', beforeB2 > 0, `${beforeB2} min`);

  const delA = await call(a.jar, 'DELETE', '/me');
  check(
    'the creator (owner of a group with members) can delete the account (F1)',
    delA.status === 200,
    `status ${delA.status} ${JSON.stringify(delA.body)}`,
  );
  const reloginA = await call({ cookies: [] }, 'POST', '/auth/login', {
    identifier: a.name,
    password: `${PASS}-work`,
  });
  check('the deleted creator can no longer log in', reloginA.status === 401, `status ${reloginA.status}`);

  const afterB2 = await minsFor(b.jar, tid2);
  check(
    "B's time survived the creator's account deletion (F2)",
    afterB2 === beforeB2 && afterB2 > 0,
    `${beforeB2} min → ${afterB2} min`,
  );
  const g2After = await call(b.jar, 'GET', `/groups/${gid2}`);
  check(
    'the group survived and ownership transferred to B (D1: transfer)',
    g2After.status === 200 && g2After.body?.my_role === 'owner',
    `status ${g2After.status} role ${g2After.body?.my_role}`,
  );

  console.log(fail ? '\nFAILED' : '\nPASS: deletion paths preserve history and notify members');
  process.exit(fail);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
