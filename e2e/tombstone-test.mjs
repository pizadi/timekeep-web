// INV-06: historical user-owned time records cannot disappear because shared
// metadata was deleted.
//
// The bug: `time_sessions.task_id REFERENCES tasks(id) ON DELETE CASCADE`, so
// deleting a GROUP task — or a group project — cascade-deleted every member's
// sessions on it. One member destroying shared metadata erased other members'
// history. The fix is a tombstone (`deleted_at`) plus a `task_name` snapshot on
// the session, so:
//
//   A logs time on a shared task  → B (with edit_tasks) deletes the task
//   → A's SESSIONS and A's REPORTS still contain that time, under the task's name
//   → the task is gone from every member's live lists
//   → A can re-create a project with the same name (the tombstone yields it)
//
// Runs against `wrangler dev` like the rest of the suite.
import { withProxyRetry } from './support/proxy-retry.mjs';

const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787/api';
const ORIGIN = new URL(BASE).origin;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42';
const SEEDED_PASSWORD = 'changemeasap';
const PASS = 'a-very-long-tombstone-pass-1';

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
      'x-device-id': jar.device ?? 'tomb',
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
  // `wrangler dev` drops requests; without this the script dies on a flaky
  // group invite rather than on the tombstone behaviour it is here to check
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
    console.error(`tombstone test: admin login failed (${li.status}) — run smoke-test.sh first`);
    process.exit(1);
  }

  const stamp = Date.now().toString(36).slice(-6);
  const a = await makeUser(admin, `ta${stamp}`);
  const b = await makeUser(admin, `tb${stamp}`);

  // a shared group project with one task
  const group = await call(a.jar, 'POST', '/groups', { name: `tomb-group-${stamp}` });
  const gid = group.body?.group?.id;
  check('group created', !!gid, `status ${group.status}`);
  const inv = await call(a.jar, 'POST', `/groups/${gid}/invites`, { username: b.name });
  const inviteId = inv.body?.invite?.id;
  const acc = await call(b.jar, 'POST', `/groups/invites/${inviteId}/accept`, {});
  const seen = await call(b.jar, 'GET', '/groups');
  check(
    'the shared project is visible to both members',
    (seen.body?.groups ?? []).some((g) => g.id === gid),
    `invite ${inv.status}/${acc.status}`,
  );

  const proj = await call(a.jar, 'POST', `/groups/${gid}/projects`, { name: `tomb-proj-${stamp}` });
  const pid = proj.body?.project?.id;
  const task = await call(a.jar, 'POST', `/projects/${pid}/tasks`, { name: 'shared work' });
  const tid = task.body?.task?.id;
  check('shared task created', !!tid, `status ${task.status}`);

  // B needs edit_tasks to delete it
  const members = await call(a.jar, 'GET', `/groups/${gid}`);
  const bMemberId = (members.body?.members ?? []).find((m) => m.username === b.name)?.id;
  const perm = await call(a.jar, 'PATCH', `/groups/${gid}/members/${bMemberId}`, {
    role: 'admin',
    perms: ['edit_tasks', 'manage_projects'],
  });
  check('B is granted edit_tasks/manage_projects', perm.status === 200, `status ${perm.status}`);

  // A records time on it, and so does B (both are affected by the cascade).
  // checkSessionTimes rejects anything before the account existed, and this
  // account was created seconds ago — so the window is derived from the account's
  // own created_at rather than from fixed epoch values.
  const me = await call(a.jar, 'GET', '/me');
  // A 60s window that starts after BOTH accounts existed (each session is
  // validated against its own account's created_at) and ends well inside the
  // "no more than 5 minutes in the future" tolerance. The summary reports whole
  // minutes, so one minute is the smallest interval that reads back as 1.
  const meB = await call(b.jar, 'GET', '/me');
  const base = Math.max(me.body?.user?.created_at ?? 0, meB.body?.user?.created_at ?? 0) + 1000;
  const start = base;
  const end = start + 60_000;
  const aSess = await call(a.jar, 'POST', '/sessions', {
    task_id: tid,
    started_at: start,
    ended_at: end,
  });
  check("A's manual session created", aSess.status === 201, `status ${aSess.status} ${JSON.stringify(aSess.body)}`);
  const bSess = await call(b.jar, 'POST', '/sessions', { task_id: tid, started_at: start, ended_at: end });
  check("B's manual session created", bSess.status === 201, `status ${bSess.status}`);

  const beforeA = await minsFor(a.jar, tid);
  const beforeB = await minsFor(b.jar, tid);
  check('A has time recorded on the shared task', beforeA !== null && beforeA > 0, `${beforeA} min`);
  check('B has time recorded on the shared task', beforeB !== null && beforeB > 0, `${beforeB} min`);

  // ---- B deletes the shared task ----
  const del = await call(b.jar, 'DELETE', `/tasks/${tid}`);
  check('B (edit_tasks) can delete the shared task', del.status === 200 || del.status === 204, `status ${del.status}`);

  // ---- INV-06: the history survives ----
  const afterA = await minsFor(a.jar, tid);
  const afterB = await minsFor(b.jar, tid);
  check(
    "A's time on the deleted task survived another user's delete",
    afterA === beforeA && afterA > 0,
    `${beforeA} min → ${afterA} min`,
  );
  check("B's own time survived too", afterB === beforeB && afterB > 0, `${beforeB} min → ${afterB} min`);

  const logA = await call(a.jar, 'GET', `/sessions?task_id=${tid}`);
  const logRows = logA.body?.sessions ?? [];
  check('the log still lists the session', logRows.length >= 1, `${logRows.length} rows`);
  check(
    'the log renders the task by its historical name',
    logRows.length > 0 && logRows[0].task_name === 'shared work',
    logRows[0] ? `task_name=${logRows[0].task_name}` : 'no rows',
  );

  // ---- the live views forget it ----
  const boot = await call(a.jar, 'GET', '/bootstrap');
  check('the task is gone from bootstrap', !(boot.body?.tasks ?? []).some((t) => t.id === tid));
  const list = await call(a.jar, 'GET', `/projects/${pid}/tasks`);
  check('the task is gone from the project listing', !(list.body?.tasks ?? []).some((t) => t.id === tid));
  const recent = await call(a.jar, 'GET', '/bootstrap');
  check('it is not a "jump back in" destination', !(recent.body?.recent ?? []).some((r) => r.task_id === tid));
  const newSess = await call(a.jar, 'POST', '/sessions', { task_id: tid, started_at: start, ended_at: end });
  check('no new time can be logged on it', newSess.status === 404, `status ${newSess.status}`);

  // ---- a tombstoned project yields its name back ----
  const pdel = await call(a.jar, 'DELETE', `/projects/${pid}`);
  check('the shared project can be deleted', pdel.status === 200, `status ${pdel.status}`);
  const recreate = await call(a.jar, 'POST', '/projects', { name: `tomb-proj-${stamp}` });
  check(
    'the same project name can be created again (the tombstone yielded it)',
    recreate.status === 201,
    `status ${recreate.status} ${JSON.stringify(recreate.body)}`,
  );

  // ---- the group-project delete keeps everyone's history too ----
  const proj2 = await call(a.jar, 'POST', `/groups/${gid}/projects`, { name: `tomb-proj2-${stamp}` });
  const pid2 = proj2.body?.project?.id;
  const task2 = await call(a.jar, 'POST', `/projects/${pid2}/tasks`, { name: 'second shared work' });
  const tid2 = task2.body?.task?.id;
  const s2 = await call(b.jar, 'POST', '/sessions', { task_id: tid2, started_at: start, ended_at: end });
  check('B logs time on a second shared task', s2.status === 201, `status ${s2.status}`);
  const before2 = await minsFor(b.jar, tid2);
  const pdel2 = await call(b.jar, 'DELETE', `/projects/${pid2}`);
  check('B deletes the whole shared project', pdel2.status === 200, `status ${pdel2.status}`);
  const after2 = await minsFor(b.jar, tid2);
  check(
    "a whole-project delete keeps members' history",
    after2 === before2 && after2 > 0,
    `${before2} min → ${after2} min`,
  );
}

await main();
console.log(fail ? '\ntombstone test FAILED' : '\ntombstone test passed');
process.exit(fail);
