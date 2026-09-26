// FR-D1 AC: export account A → import into fresh account B (merge) →
// sessions, dependencies, and subtask states identical (ids preserved).
// FR-F: pomodoro start → focus phase; skip → idle.
const BASE = 'http://127.0.0.1:8787';

async function raw(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', cookie, 'x-device-id': 'rt-test', ...(opts.headers ?? {}) },
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
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').split(';')[0];

async function main() {
  // --- account A (existing user dana, created by smoke-test.sh) ---
  const a = cookieOf(
    await raw('/auth/login', { method: 'POST', body: { identifier: 'dana', password: 'purple-marmalade-tuesday' } }),
  );
  const exported = await fetch(`${BASE}/api/export?format=json`, { headers: { cookie: a } }).then((r) => r.json());
  console.log(
    `exported: projects=${exported.projects.length} tasks=${exported.tasks.length} subtasks=${exported.subtasks.length} deps=${exported.dependencies.length} sessions=${exported.sessions.length}`,
  );

  // --- delete account A, then fresh account B (spec AC: export → delete → new account → import) ---
  const del = await raw('/me', { method: 'DELETE' }, a);
  console.log('delete account A:', del.status, JSON.stringify(del.body));
  const stamp = Date.now() % 100000;

  // no self-signup: account B is created by the admin (temp password + forced change)
  const admin = cookieOf(
    await raw('/auth/login', {
      method: 'POST',
      body: {
        identifier: process.env.ADMIN_USERNAME ?? 'admin',
        password: process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42',
      },
    }),
  );
  if (!admin) {
    console.error('admin login failed');
    process.exit(1);
  }
  const bName = `rt${stamp}`;
  const createB = await raw(
    '/admin/users',
    {
      method: 'POST',
      body: { username: bName, name: 'RT', password: 'rt-temp-passphrase-42' },
    },
    admin,
  );
  if (createB.status !== 201) {
    console.error('create user B failed', createB.body);
    process.exit(1);
  }
  const bLogin = await raw('/auth/login', {
    method: 'POST',
    body: { identifier: bName, password: 'rt-temp-passphrase-42' },
  });
  const b = cookieOf(bLogin);
  if (!b || !bLogin.body?.must_change_password) {
    console.error('user B login failed', bLogin.body);
    process.exit(1);
  }
  const chB = await raw(
    '/me/password',
    {
      method: 'POST',
      body: { current_password: 'rt-temp-passphrase-42', password: 'another-secure-passphrase-42' },
    },
    b,
  );
  if (chB.status !== 200) {
    console.error('user B password change failed', chB.body);
    process.exit(1);
  }
  const aLoginGone = await raw('/auth/login', {
    method: 'POST',
    body: { identifier: 'dana', password: 'purple-marmalade-tuesday' },
  });
  console.log('login after deletion fails (FR-A8 AC):', aLoginGone.status === 401);

  // --- import merge ---
  const imp = await raw(
    '/import',
    {
      method: 'POST',
      body: { mode: 'merge', data: { ...exported, user: undefined, settings: exported.settings } },
    },
    b,
  );
  console.log('import:', imp.status, JSON.stringify(imp.body.summary ?? imp.body));

  // --- compare ---
  const bootB = (await raw('/bootstrap', {}, b)).body;
  const sameIds = (arrA, arrB) => arrA.length === arrB.length && arrA.every((x) => arrB.some((y) => y.id === x.id));
  const tasksOk = sameIds(exported.tasks, bootB.tasks);
  const depsOk = sameIds(exported.dependencies, bootB.dependencies);
  const subOk = exported.subtasks.every((s) => {
    const match = bootB.subtasks.find((y) => y.id === s.id);
    return match && !!match.done === !!s.done; // subtask states identical
  });
  const logB = await raw('/sessions', {}, b);
  const sessionsOk =
    logB.body.sessions.length ===
    exported.sessions.filter((s) => s.ended_at).length +
      Math.min(exported.sessions.filter((s) => !s.ended_at).length, 200);
  console.log(
    `ids preserved — tasks:${tasksOk} deps:${depsOk} subtaskStates:${subOk} sessionsImported:${logB.body.sessions.length}/${exported.sessions.length}`,
  );

  // --- pomodoro machine (FR-F1/F4) ---
  const task = bootB.tasks.find((t) => t.name === 'Design') ?? bootB.tasks[0];
  const pomoStart = await raw('/pomo/start', { method: 'POST', body: { task_id: task.id } }, b);
  const phase1 = pomoStart.body?.pomo?.phase;
  const timer = await raw('/timer', {}, b);
  const running = timer.body?.session?.task_id === task.id;
  const skip = await raw('/pomo/skip', { method: 'POST' }, b);
  const phase2 = skip.body?.pomo?.phase;
  const pomoOk = phase1 === 'focus' && running && phase2 === 'idle';
  console.log(
    `pomodoro — start→focus:${phase1 === 'focus'} timerStartedWithPomo:${running} skip→idle:${phase2 === 'idle'}`,
  );

  // sessionsOk was computed and printed but never asserted (ESLint's dead-variable
  // check caught it) — the imported session count is part of the verdict now
  const ok = tasksOk && depsOk && subOk && sessionsOk && pomoOk;
  console.log(ok ? 'PASS: export→import round-trip identical; pomodoro state machine correct' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
