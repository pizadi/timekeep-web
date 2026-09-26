// Targeted regression probes for behaviors the other e2e scripts don't cover.
const BASE = 'http://127.0.0.1:8787';
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function raw(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', 'x-device-id': 'regression-check', cookie, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function login(identifier, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
    headers: { 'content-type': 'application/json', 'x-device-id': 'regression-check' },
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), cookie };
}

// fresh admin session
const admin = await login('admin', 'purple-marmalade-admin-42');
const CK = admin.cookie;

// create a dedicated user for this check
const uname = `regcheck${Date.now() % 100000}`;
await raw('/admin/users', { method: 'POST', body: { username: uname, password: 'regression-pass-42' } }, CK);
const u = await login(uname, 'regression-pass-42');
check('fresh user login (forced change)', u.status === 200 && u.body.must_change_password === true);

// change password (CSRF-free client: no Origin header → double-submit not required)
const ch = await raw(
  '/me/password',
  { method: 'POST', body: { current_password: 'regression-pass-42', password: 'regression-new-pass-42' } },
  u.cookie,
);
check('password change works (verifyPassword intact after L15 edit)', ch.status === 200, JSON.stringify(ch.body));

const ck = (await login(uname, 'regression-new-pass-42')).cookie;
const boot = (await raw('/bootstrap', {}, ck)).body;
const proj = boot.projects[0] ?? (await raw('/projects', { method: 'POST', body: { name: 'DC' } }, ck)).body.project;
const task = (await raw(`/projects/${proj.id}/tasks`, { method: 'POST', body: { name: 'dc-task' } }, ck)).body.task;

// --- open-ended manual session must 422, not 500 ---
const open = await raw(
  '/sessions',
  { method: 'POST', body: { task_id: task.id, started_at: Date.now() - 60_000, ended_at: null } },
  ck,
);
check('open-ended manual session rejected with 422', open.status === 422, `status ${open.status}`);
const openPatch = await raw(
  '/sessions',
  { method: 'POST', body: { task_id: task.id, started_at: Date.now(), ended_at: Date.now() + 120_000 } },
  ck,
);
check(
  'closed manual session still accepted',
  openPatch.status === 201,
  `status ${openPatch.status} ${JSON.stringify(openPatch.body).slice(0, 120)}`,
);
const editOpen = await raw(`/sessions/${openPatch.body.session.id}`, { method: 'PATCH', body: { ended_at: null } }, ck);
check('PATCH clearing ended_at rejected with 422', editOpen.status === 422, `status ${editOpen.status}`);

// --- timer start/stop still works after the reorder ---
const t1 = await raw('/timer/start', { method: 'POST', body: { task_id: task.id } }, ck);
check('timer start works', t1.status === 200, `status ${t1.status}`);
const t2 = await raw('/timer/start', { method: 'POST', body: { task_id: task.id } }, ck);
check('second start → 409 already_running (DO ghost-state guard)', t2.status === 409, `status ${t2.status}`);
const t3 = await raw('/timer/stop', { method: 'POST', body: {} }, ck);
check('timer stop works', t3.status === 200, `status ${t3.status}`);

// --- deleting the running task's project clears the DO ghost ---
await raw('/timer/start', { method: 'POST', body: { task_id: task.id } }, ck);
const delP = await raw(`/projects/${proj.id}`, { method: 'DELETE' }, ck);
check('project with running timer deletes', delP.status === 200, `status ${delP.status}`);
await new Promise((r) => setTimeout(r, 500)); // let the notify reach the DO
const proj2 = (await raw('/projects', { method: 'POST', body: { name: 'DC2' } }, ck)).body.project;
const task2 = (await raw(`/projects/${proj2.id}/tasks`, { method: 'POST', body: { name: 'dc-task2' } }, ck)).body.task;
const nextStart = await raw('/timer/start', { method: 'POST', body: { task_id: task2.id } }, ck);
check(
  'timer start after deleting the running task → 200 (no ghost 409)',
  nextStart.status === 200,
  `status ${nextStart.status} ${JSON.stringify(nextStart.body).slice(0, 120)}`,
);
await raw('/timer/stop', { method: 'POST', body: {} }, ck);

// --- reset-request carries no dev link even with EMAIL_DEV_MODE=1 ---
const rr = await raw('/auth/reset-request', { method: 'POST', body: { email: 'noreply@example.com' } }, undefined);
check(
  'reset-request response carries no reset link',
  rr.status === 200 && rr.body.dev_reset_url === undefined && !JSON.stringify(rr.body).includes('token'),
  JSON.stringify(rr.body),
);

// --- resend-verification endpoint exists and requires auth ---
const rvAnon = await raw('/auth/resend-verification', { method: 'POST', body: {} }, undefined);
check('resend-verification requires auth', rvAnon.status === 401, `status ${rvAnon.status}`);
// admin-created users have no real mailbox (email = username, no '@') → 422 no_email
const rvAuthed = await raw('/auth/resend-verification', { method: 'POST', body: {} }, ck);
check(
  'resend-verification reports no-mailbox accounts (422 no_email)',
  rvAuthed.status === 422 && rvAuthed.body.error?.code === 'no_email',
  `status ${rvAuthed.status}`,
);
// a user WITH a real (pre-verified) mailbox → ok:true short-circuit
// (username/email unique per run — admin creation conflicts on reuse otherwise)
const wmId = `${Date.now() % 100000}`;
const withMail = `withmail${wmId}`;
await raw(
  '/admin/users',
  {
    method: 'POST',
    body: { username: withMail, name: 'WM', email: `withmail${wmId}@example.com`, password: 'withmail-pass-424242' },
  },
  CK,
);
const wmLogin = await login(withMail, 'withmail-pass-424242');
// the call's side effect is the point (rotate the password), the result isn't read
await raw(
  '/me/password',
  {
    method: 'POST',
    body: { current_password: 'withmail-pass-424242', password: 'withmail-new-pass-424242' },
  },
  wmLogin.cookie,
);
const wmCk = (await login(withMail, 'withmail-new-pass-424242')).cookie;
const rvMail = await raw('/auth/resend-verification', { method: 'POST', body: {} }, wmCk);
check(
  'resend-verification OK for pre-verified mailbox user',
  rvMail.status === 200 && rvMail.body.ok === true,
  `status ${rvMail.status}`,
);

// --- unauthenticated token endpoints are rate limited (default 30/15min) ---
// (RL_TOKEN_IP is raised in .dev.vars for e2e scripts; with the override removed
// wrangler restarts and the default applies)
let limited = false;
for (let i = 0; i < 45; i++) {
  const r = await raw('/auth/verify-email', { method: 'POST', body: { token: 'x'.repeat(32) } }, undefined);
  if (r.status === 429) {
    limited = true;
    break;
  }
}
check('verify-email hammering hits the IP rate limit (429)', limited);

// --- import rejects cycles + open-ended sessions, emits events ---
const pA = (await raw('/projects', { method: 'POST', body: { name: `IMP-${Date.now() % 10000}` } }, ck)).body.project;
const iA = (await raw(`/projects/${pA.id}/tasks`, { method: 'POST', body: { name: 'a' } }, ck)).body.task;
const iB = (await raw(`/projects/${pA.id}/tasks`, { method: 'POST', body: { name: 'b' } }, ck)).body.task;
await raw(`/tasks/${iA.id}/deps`, { method: 'POST', body: { depends_on_id: iB.id } }, ck); // a depends on b
const imp = await raw(
  '/import',
  {
    method: 'POST',
    body: {
      mode: 'merge',
      data: {
        projects: [{ id: pA.id, name: pA.name }],
        tasks: [
          { id: iA.id, project_id: pA.id, name: 'a' },
          { id: iB.id, project_id: pA.id, name: 'b' },
        ],
        dependencies: [{ task_id: iB.id, depends_on_id: iA.id }], // b depends on a → cycle
        sessions: [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', task_id: iA.id, started_at: null, ended_at: Date.now() }],
      },
    },
  },
  ck,
);
check(
  'cyclic import edge skipped',
  imp.status === 200 && imp.body.summary.dependencies.created === 0,
  JSON.stringify(imp.body.summary?.dependencies),
);
check(
  'epoch-1970/null-start session skipped',
  imp.status === 200 && imp.body.summary.sessions.created === 0,
  JSON.stringify(imp.body.summary?.sessions),
);
check(
  'import.completed event emitted',
  (imp.body.events ?? []).some((e) => e.type === 'import.completed'),
);

// --- import with entity-limit overflow → 422 ---
const impLimit = await raw(
  '/import',
  {
    method: 'POST',
    body: {
      mode: 'duplicate',
      data: {
        projects: Array.from({ length: 250 }, (_, i) => ({
          id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`,
          name: `p${i}`,
        })),
      },
    },
  },
  ck,
);
check('import over project limit → 422', impLimit.status === 422, `status ${impLimit.status}`);

// --- restore with foreign dependency ids is skipped ---
const other = `forchk${Date.now() % 100000}`;
await raw('/admin/users', { method: 'POST', body: { username: other, password: 'foreign-user-pass-42' } }, CK);
const otherLogin = await login(other, 'foreign-user-pass-42');
await raw(
  '/me/password',
  { method: 'POST', body: { current_password: 'foreign-user-pass-42', password: 'foreign-user-new-pass-42' } },
  otherLogin.cookie,
);
const otherCk = (await login(other, 'foreign-user-new-pass-42')).cookie;
// fresh accounts own no data — give the other user a task to point at
const otherProj = (await raw('/projects', { method: 'POST', body: { name: 'other-p' } }, otherCk)).body.project;
const otherTask = (await raw(`/projects/${otherProj.id}/tasks`, { method: 'POST', body: { name: 'other-t' } }, otherCk))
  .body.task;
check('fixture (other user task exists)', !!otherTask);
const foreignRestore = await raw(
  '/restore',
  {
    method: 'POST',
    body: { dependencies: [{ task_id: task2.id, depends_on_id: otherTask.id }] },
  },
  ck,
);
check(
  'cross-user dependency row rejected',
  foreignRestore.status === 200 && foreignRestore.body.restored === 0,
  JSON.stringify(foreignRestore.body),
);
const depsAfter = (await raw(`/projects/${proj2.id}/deps`, {}, ck)).body.dependencies;
check('no foreign edge landed in the DB', depsAfter.length === 0, JSON.stringify(depsAfter));

console.log(failures === 0 ? '\nALL REGRESSION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
