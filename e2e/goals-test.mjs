// Goals (v0.6.0): CRUD, progress buckets, derived status, pro-rating, caps.
//
// The behaviours pinned here:
//   - a goal's progress windows carry pro-rated targets when the goal's
//     lifetime only partially covers a period (creation mid-period, expiry
//     mid-period) — ceil, min 1 minute;
//   - status is DERIVED, never stored: all scope items done → 'completed',
//     un-checking one → 'active' again (completion is not destructive);
//   - archive/un-archive, hard delete (undo re-creates client-side);
//   - scope refs must resolve to live, accessible nodes (404/422 otherwise);
//   - the per-user goal cap is enforced INSIDE the INSERT (guarded statement);
//   - goal events ride the normal sync pipeline (bootstrap + envelope + /sync).
//
// Runs against `wrangler dev` like the rest of the suite.
import { withProxyRetry } from './support/proxy-retry.mjs';

const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787/api';
const ORIGIN = new URL(BASE).origin;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42';
const SEEDED_PASSWORD = 'changemeasap';
const PASS = 'a-very-long-goals-pass-1';

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
      'x-device-id': jar.device ?? 'goals',
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
  return withProxyRetry(`${method} ${path}`, () => callOnce(jar, method, path, data));
}

async function makeUser(admin, name) {
  const created = await call(admin, 'POST', '/admin/users', { username: name, password: PASS });
  if (created.status !== 201)
    throw new Error(`could not create ${name}: ${created.status} ${JSON.stringify(created.body)}`);
  const jar = { cookies: [] };
  await call(jar, 'POST', '/auth/login', { identifier: name, password: PASS });
  await call(jar, 'POST', '/me/password', { current_password: PASS, password: `${PASS}-work` });
  const me = await call(jar, 'GET', '/me');
  return { jar, name, created_at: me.body?.user?.created_at ?? 0 };
}

async function main() {
  const admin = { cookies: [] };
  let li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD });
  if (li.status !== 200) {
    li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: SEEDED_PASSWORD });
    if (li.status === 200 && li.body?.must_change_password) {
      await call(admin, 'POST', '/me/password', { current_password: SEEDED_PASSWORD, password: ADMIN_PASSWORD });
      li = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: ADMIN_PASSWORD });
    }
  }
  if (li.status !== 200) {
    console.error(`goals test: admin login failed (${li.status}) — run smoke-test.sh first`);
    process.exit(1);
  }

  const stamp = Date.now().toString(36).slice(-6);
  const a = await makeUser(admin, `ga${stamp}`);
  const b = await makeUser(admin, `gb${stamp}`);

  const proj = await call(a.jar, 'POST', '/projects', { name: `goals-proj-${stamp}` });
  const pid = proj.body?.project?.id;
  const task = await call(a.jar, 'POST', `/projects/${pid}/tasks`, { name: 'goal work' });
  const tid = task.body?.task?.id;
  const sub = await call(a.jar, 'POST', `/tasks/${tid}/subtasks`, { name: 'goal sub' });
  const sid = sub.body?.subtask?.id;
  check('project/task/subtask created', !!pid && !!tid && !!sid);

  // a 1-minute DAILY goal on the task — the first (partial) day pro-rates to
  // ceil(1 * covered/full) which clamps to 1, so the 1-minute session meets it
  const mk = await call(a.jar, 'POST', '/goals', {
    name: 'daily nudge',
    period: 'day',
    direction: 'at_least',
    target_minutes: 1,
    scope: [`task:${tid}`],
  });
  check('goal created', mk.status === 201, `status ${mk.status} ${JSON.stringify(mk.body)}`);
  const goal = mk.body?.goal;
  check('the response envelope carries the event', mk.body?.events?.[0]?.type === 'goal.created');

  const boot = await call(a.jar, 'GET', '/bootstrap');
  check(
    'bootstrap lists the goal (scope parsed)',
    (boot.body?.goals ?? []).some((g) => g.id === goal.id && Array.isArray(g.scope)),
  );

  // one FULL minute of tracked time, after the goal existed (a goal's timeline
  // opens at its created_at — earlier sessions must not count). The session is
  // back-dated to sit just inside the goal's first window and ends in the past,
  // so the progress clip at `now` counts the whole minute; that requires the
  // goal to be more than a minute old, hence the wait.
  await new Promise((r) => setTimeout(r, 62_000));
  const start = goal.created_at + 1000;
  const sess = await call(a.jar, 'POST', '/sessions', {
    task_id: tid,
    started_at: start,
    ended_at: start + 60_000,
  });
  check('manual session on the scoped task', sess.status === 201, `status ${sess.status}`);

  const prog = await call(a.jar, 'GET', '/goals/progress?windows=4');
  const entry = (prog.body?.goals ?? []).find((g) => g.goal.id === goal.id);
  check('progress returns the goal', !!entry);
  const cur = entry?.windows?.find((w) => w.current);
  check('the current (partial, pro-rated) window is present', !!cur, JSON.stringify(entry?.windows));
  check('the tracked minute lands in the current window', cur?.actual === 1, `actual=${cur?.actual}`);
  check('the first partial day is pro-rated to the 1-minute floor', cur?.target === 1, `target=${cur?.target}`);
  check('status is active (task not done)', entry?.status === 'active', `status ${entry?.status}`);

  // ---- derived completion: all scope done → completed; unchecking → active ----
  const done = await call(a.jar, 'PATCH', `/tasks/${tid}`, { done: true });
  check('task marked done', done.status === 200, `status ${done.status}`);
  const progDone = await call(a.jar, 'GET', '/goals/progress?windows=4');
  const entryDone = (progDone.body?.goals ?? []).find((g) => g.goal.id === goal.id);
  check(
    'all scope done → status completed (derived, not stored)',
    entryDone?.status === 'completed',
    `status ${entryDone?.status}`,
  );
  const undid = await call(a.jar, 'PATCH', `/tasks/${tid}`, { done: false });
  check('task un-done', undid.status === 200, `status ${undid.status}`);
  const progUndid = await call(a.jar, 'GET', '/goals/progress?windows=4');
  const entryUndid = (progUndid.body?.goals ?? []).find((g) => g.goal.id === goal.id);
  check(
    'un-checking re-activates the goal (completion is not permanent)',
    entryUndid?.status === 'active',
    `status ${entryUndid?.status}`,
  );

  // ---- archive / un-archive ----
  const arch = await call(a.jar, 'PATCH', `/goals/${goal.id}`, { archived: true });
  check('archive works', arch.status === 200 && arch.body?.goal?.archived_at !== null, `status ${arch.status}`);
  const unarch = await call(a.jar, 'PATCH', `/goals/${goal.id}`, { archived: false });
  check(
    'un-archive works',
    unarch.status === 200 && unarch.body?.goal?.archived_at === null,
    `status ${unarch.status}`,
  );

  // ---- expiry pro-rating: a 60m/day goal ending in 1 hour has target = ceil(60·covered/full) ----
  const now = Date.now();
  const exp = await call(a.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 60,
    scope: [`task:${tid}`],
    ends_at: now + 3600_000,
  });
  check('expiring goal created', exp.status === 201, `status ${exp.status} ${JSON.stringify(exp.body)}`);
  const expGoal = exp.body?.goal;
  const progExp = await call(a.jar, 'GET', '/goals/progress?windows=4');
  const expEntry = (progExp.body?.goals ?? []).find((g) => g.goal.id === expGoal.id);
  const w = expEntry?.windows?.[expEntry.windows.length - 1];
  const covered = Math.min(expGoal.ends_at, w.end) - Math.max(expGoal.created_at, w.start);
  const full = w.end - w.start;
  const expected = Math.max(1, Math.ceil((60 * covered) / full));
  check(
    'the expiry-clipped final window is pro-rated',
    w?.target === expected,
    `target=${w?.target} expected=${expected} (covered ${covered}ms of ${full}ms)`,
  );
  check('a not-yet-passed expiry keeps the goal active', expEntry?.status === 'active', `status ${expEntry?.status}`);

  // ---- scope validation ----
  const bogus = await call(a.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 30,
    scope: ['task:BOGUS'],
  });
  check('unknown scope ref is rejected', bogus.status === 422, `status ${bogus.status}`);
  const foreign = await call(b.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 30,
    scope: [`task:${tid}`],
  });
  check("another user's task is rejected as scope", foreign.status === 422, `status ${foreign.status}`);
  const emptyScope = await call(a.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 30,
    scope: [],
  });
  check('empty scope is rejected', emptyScope.status === 422, `status ${emptyScope.status}`);
  const past = await call(a.jar, 'POST', '/goals', {
    period: 'day',
    direction: 'at_least',
    target_minutes: 30,
    scope: [`task:${tid}`],
    ends_at: now - 3600_000,
  });
  check('a past expiry is rejected', past.status === 422, `status ${past.status}`);

  // ---- hard delete (undo re-creates client-side from the returned row) ----
  const del = await call(a.jar, 'DELETE', `/goals/${expGoal.id}`);
  check(
    'delete returns the row for the undo toast',
    del.status === 200 && del.body?.goal?.id === expGoal.id,
    `status ${del.status}`,
  );
  const progDel = await call(a.jar, 'GET', '/goals/progress?windows=4');
  check('the deleted goal is gone from progress', !(progDel.body?.goals ?? []).some((g) => g.goal.id === expGoal.id));

  // ---- the per-user cap is decided inside the INSERT ----
  // (the account holds 1 goal at this point — the expiring one was deleted —
  // so 29 more fit under LIMITS.goalsPerUser = 30, then the INSERT matches 0 rows)
  let created = 0;
  let limitHit = false;
  for (let i = 0; i < 40 && !limitHit; i++) {
    const r = await call(a.jar, 'POST', '/goals', {
      period: 'week',
      direction: 'at_most',
      target_minutes: 5,
      scope: [`subtask:${sid}`],
    });
    if (r.status === 201) created += 1;
    else if (r.status === 422 && r.body?.error?.code === 'limit') limitHit = true;
    else {
      check('unexpected response during cap fill', false, `status ${r.status} ${JSON.stringify(r.body)}`);
      break;
    }
  }
  check(
    'goal cap enforced at 30 per account (29 created here, then a 422)',
    limitHit && created === 29,
    `created=${created} limitHit=${limitHit}`,
  );

  // ---- events ride the sync pipeline ----
  const sync = await call(a.jar, 'GET', '/sync?since=0');
  const types = (sync.body?.events ?? []).map((e) => e.type);
  check(
    'sync log carries goal events',
    types.includes('goal.created') && types.includes('goal.updated') && types.includes('goal.deleted'),
    types.filter((t) => t.startsWith('goal.')).join(','),
  );
}

await main();
console.log(fail ? '\ngoals test FAILED' : '\ngoals test passed');
process.exit(fail);
