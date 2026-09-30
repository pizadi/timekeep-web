// F3 (audit): /import must verify OWNERSHIP of the rows it touches and guard
// session overlap; F19: goals must survive export/import.
//
// The holes (pre-fix behaviour, each demonstrated by a red run):
//   - a task is accepted when its project_id appears IN THE FILE, even when
//     that project belongs to someone else — the project upsert no-ops on the
//     WHERE projects.user_id clause, but the task still inserts pointing at a
//     foreign project;
//   - sessions never validate task_id — a session can attach to ANY existing
//     task id, and the insert copies that task's NAME into task_name (a name-
//     leak channel through the JSON export);
//   - no same-task overlap guard on the import path (POST /sessions has one),
//     so a repeated merge double-counts time;
//   - a dependency edge whose endpoints were skipped still inserts → FK 500
//     (dangling reference);
//   - the export payload omits goals entirely (F19).
//
// Runs against `wrangler dev` like the rest of the suite; creates its own users.
import { withProxyRetry } from './support/proxy-retry.mjs';

const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787/api';
const ORIGIN = new URL(BASE).origin;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42';
const SEEDED_PASSWORD = 'changemeasap';
const PASS = 'a-very-long-importauth-pass-1';

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
      'x-device-id': jar.device ?? 'iauth',
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

// ULID (Crockford base32, 10-char time + 16-char randomness) — imports in
// merge mode require well-formed ids
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + [...buf].map((b) => ENC[b % 32]).join('');
}

async function makeUser(admin, name) {
  const created = await call(admin, 'POST', '/admin/users', { username: name, password: PASS });
  if (created.status !== 201)
    throw new Error(`could not create ${name}: ${created.status} ${JSON.stringify(created.body)}`);
  const jar = { cookies: [], device: `iauth-${name}` };
  await call(jar, 'POST', '/auth/login', { identifier: name, password: PASS });
  const changed = await call(jar, 'POST', '/me/password', { current_password: PASS, password: `${PASS}-work` });
  if (changed.status !== 200) throw new Error(`could not clear the password gate for ${name}`);
  return { jar, name };
}

async function main() {
  const admin = { cookies: [], device: 'iauth-admin' };
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
    console.error(`import-auth test: admin login failed (${li.status}) — run smoke-test.sh first`);
    process.exit(1);
  }

  const stamp = Date.now().toString(36).slice(-6);
  const a = await makeUser(admin, `ia${stamp}a`);
  const b = await makeUser(admin, `ib${stamp}b`);

  // session windows: after BOTH accounts exist, inside the future tolerance
  const [meA, meB] = await Promise.all([call(a.jar, 'GET', '/me'), call(b.jar, 'GET', '/me')]);
  const base = Math.max(meA.body?.user?.created_at ?? 0, meB.body?.user?.created_at ?? 0) + 1000;

  // 60s windows at 61s spacing: disjoint, each reports as exactly 1 minute
  // (the summary rounds the per-task SUM), and the LAST window starts at
  // base+183s — inside the 5-minute future tolerance, which the previous
  // draft's later windows (base+540s) violated: a session starting beyond
  // now+5min is skipped by the interval rules before any ownership check.
  const win = (n) => [base + n * 61_000, base + n * 61_000 + 60_000];

  // A owns a project, a task, a session on it and a goal scoped to the task
  const proj = await call(a.jar, 'POST', '/projects', { name: `ia-proj-${stamp}` });
  const pA = proj.body?.project?.id;
  check('A project created', !!pA, `status ${proj.status}`);
  const task = await call(a.jar, 'POST', `/projects/${pA}/tasks`, { name: 'a-work' });
  const tA = task.body?.task?.id;
  check('A task created', !!tA, `status ${task.status}`);
  const [s, e] = win(1);
  const sess = await call(a.jar, 'POST', '/sessions', { task_id: tA, started_at: s, ended_at: e });
  check('A session created', sess.status === 201, `status ${sess.status}`);
  const goal = await call(a.jar, 'POST', '/goals', {
    name: 'a-focus',
    period: 'day',
    direction: 'at_least',
    target_minutes: 30,
    scope: [`task:${tA}`],
  });
  const gA = goal.body?.goal?.id;
  check('A goal created', !!gA, `status ${goal.status} ${JSON.stringify(goal.body)}`);

  async function aTaskIds() {
    const list = await call(a.jar, 'GET', `/projects/${pA}/tasks`);
    return (list.body?.tasks ?? []).map((t) => t.id);
  }
  async function aSessionCount() {
    const log = await call(a.jar, 'GET', `/sessions?task_id=${tA}`);
    return (log.body?.sessions ?? []).length;
  }

  // ---------- scenario 1: B imports a file referencing A's ids ----------
  {
    const planted1 = ulid();
    const planted2 = ulid();
    const foreignSess = ulid();
    const [s1, e1] = win(2);
    const imp = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: {
        projects: [{ id: pA, name: 'hijacked', created_at: base }],
        tasks: [
          { id: planted1, project_id: pA, name: 'planted-1', created_at: base },
          { id: planted2, project_id: pA, name: 'planted-2', created_at: base },
        ],
        subtasks: [{ id: ulid(), task_id: planted1, name: 'planted-sub', created_at: base }],
        dependencies: [{ task_id: planted1, depends_on_id: planted2, created_at: base }],
        sessions: [{ id: foreignSess, task_id: tA, started_at: s1, ended_at: e1, created_at: base }],
      },
    });
    check(
      'cross-user import answered (no 500)',
      imp.status === 200,
      `status ${imp.status} ${JSON.stringify(imp.body).slice(0, 200)}`,
    );
    const sum = imp.body?.summary ?? {};
    check('the foreign project row was skipped', (sum.projects?.skipped ?? 0) >= 1, JSON.stringify(sum.projects));
    check(
      'tasks pointing at a foreign project were skipped',
      (sum.tasks?.skipped ?? 0) >= 2,
      JSON.stringify(sum.tasks),
    );
    check('the subtask on a skipped task was skipped', (sum.subtasks?.skipped ?? 0) >= 1, JSON.stringify(sum.subtasks));
    check(
      'the dependency between skipped tasks was skipped',
      (sum.dependencies?.skipped ?? 0) >= 1,
      JSON.stringify(sum.dependencies),
    );
    check('the session on a foreign task was skipped', (sum.sessions?.skipped ?? 0) >= 1, JSON.stringify(sum.sessions));

    const aIds = await aTaskIds();
    check('nothing was planted in A’s project', aIds.length === 1 && aIds[0] === tA, `tasks: ${aIds.length}`);
    const aCount = await aSessionCount();
    check('A’s task gained no sessions', aCount === 1, `sessions on tA: ${aCount}`);
    const bootB = await call(b.jar, 'GET', '/bootstrap');
    const bTaskNames = (bootB.body?.tasks ?? []).map((t) => t.name);
    check(
      'nothing named “planted” exists anywhere',
      !bTaskNames.some((n) => String(n).startsWith('planted')),
      bTaskNames.join(','),
    );
    const expB = await call(b.jar, 'GET', '/export');
    check('B’s export leaks none of A’s task names', !JSON.stringify(expB.body ?? {}).includes('a-work'));
  }

  // ---------- scenario 1b: dangling references are skipped, never a 500 ----
  {
    // both tasks reference a project absent from the file → both skipped;
    // the edge between them must not insert (FK) — pre-fix this 500'd
    const dx = ulid();
    const dy = ulid();
    const missing = ulid();
    const imp = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: {
        tasks: [
          { id: dx, project_id: missing, name: 'dangling-x', created_at: base },
          { id: dy, project_id: missing, name: 'dangling-y', created_at: base },
        ],
        dependencies: [{ task_id: dx, depends_on_id: dy, created_at: base }],
      },
    });
    check('import with dangling edge answered (no 500)', imp.status === 200, `status ${imp.status}`);
    check(
      'the dangling edge was skipped',
      (imp.body?.summary?.dependencies?.skipped ?? 0) >= 1,
      JSON.stringify(imp.body?.summary?.dependencies),
    );
  }

  // ---------- scenario 2: a goal scoped to a foreign project is skipped ----
  {
    const imp = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: {
        goals: [
          {
            id: ulid(),
            name: 'scope-steal',
            period: 'day',
            direction: 'at_least',
            target_minutes: 30,
            scope: [`project:${pA}`],
            created_at: base,
          },
        ],
      },
    });
    check('foreign-scoped goal import answered', imp.status === 200, `status ${imp.status}`);
    check(
      'the foreign-scoped goal was skipped',
      (imp.body?.summary?.goals?.skipped ?? 0) >= 1,
      JSON.stringify(imp.body?.summary?.goals),
    );
    const prog = await call(b.jar, 'GET', '/goals/progress');
    check('B has no “scope-steal” goal', !(prog.body?.goals ?? []).some((g) => g.goal?.name === 'scope-steal'));
  }

  // ---------- scenario 3: merge-mode re-import does not double-count ------
  {
    const projB = await call(b.jar, 'POST', '/projects', { name: `ia-own-${stamp}` });
    const pB = projB.body?.project?.id;
    const taskB = await call(b.jar, 'POST', `/projects/${pB}/tasks`, { name: 'b-work' });
    const tB = taskB.body?.task?.id;
    const [sA, eA] = win(0);
    const [sB, eB] = win(1);
    const mk = (id, started, ended) => ({ id, task_id: tB, started_at: started, ended_at: ended, created_at: base });
    const sess1 = ulid();
    const sess2 = ulid();
    const first = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(sess1, sA, eA), mk(sess2, sB, eB)] },
    });
    check(
      'B’s own 2-session import created',
      first.status === 200 && first.body?.summary?.sessions?.created === 2,
      JSON.stringify(first.body?.summary?.sessions),
    );

    async function bMinutes() {
      const rep = await call(b.jar, 'GET', '/reports/summary');
      const row = (rep.body?.table ?? []).find((r) => r.task_id === tB);
      return Number(row?.all ?? 0);
    }
    const before = await bMinutes();
    check('2 minutes recorded', before === 2, `${before} min`);

    // same ids again → updated, never re-created or double-counted
    const again = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(sess1, sA, eA), mk(sess2, sB, eB)] },
    });
    check(
      're-importing the same ids updates them',
      again.body?.summary?.sessions?.updated === 2 && again.body?.summary?.sessions?.created === 0,
      JSON.stringify(again.body?.summary?.sessions),
    );
    const afterAgain = await bMinutes();
    check('same-id re-import did not double-count', afterAgain === before, `${before} → ${afterAgain} min`);

    // NEW ids, SAME ranges → the overlap guard must skip them
    const overlap = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sA, eA), mk(ulid(), sB, eB)] },
    });
    check(
      'overlapping re-import with new ids is skipped',
      overlap.body?.summary?.sessions?.skipped === 2 && overlap.body?.summary?.sessions?.created === 0,
      JSON.stringify(overlap.body?.summary?.sessions),
    );
    const afterOverlap = await bMinutes();
    check('overlap-skipped import did not double-count', afterOverlap === before, `${before} → ${afterOverlap} min`);

    // NEW ids, DISJOINT ranges → created; time grows by exactly the new rows
    const [sC, eC] = win(2);
    const [sD, eD] = win(3);
    const fresh = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sC, eC), mk(ulid(), sD, eD)] },
    });
    check(
      'disjoint fresh sessions import',
      fresh.body?.summary?.sessions?.created === 2,
      JSON.stringify(fresh.body?.summary?.sessions),
    );
    const afterFresh = await bMinutes();
    check('disjoint import counts exactly its new time', afterFresh === before + 2, `${before} → ${afterFresh} min`);

    // a timer-style overlap (partial OR contained — /timer/start enforces only
    // the single-RUNNING invariant, so production data legitimately holds both
    // shapes: a timer started and stopped inside a future-dated manual entry)
    // must import — a restore never drops time
    const [sP, eP] = win(4);
    const baseRow = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sP, eP)] },
    });
    check(
      'the partial-overlap fixture imported',
      baseRow.body?.summary?.sessions?.created === 1,
      JSON.stringify(baseRow.body?.summary?.sessions),
    );
    const partial = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sP + 30_000, eP + 30_000)] },
    });
    check(
      'a partial overlap (timer-style) imports too',
      partial.body?.summary?.sessions?.created === 1,
      JSON.stringify(partial.body?.summary?.sessions),
    );
    const timerInManual = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sP + 10_000, sP + 20_000)] },
    });
    check(
      'a contained (timer-style) overlap imports too',
      timerInManual.body?.summary?.sessions?.created === 1,
      JSON.stringify(timerInManual.body?.summary?.sessions),
    );
    const afterOverlaps = await bMinutes();
    check(
      'overlap rows all count (no silent drop)',
      afterOverlaps === afterFresh + 2, // the task's SUM rounds once: 60+60+10s → 2 min
      `${afterFresh} → ${afterOverlaps} min`,
    );

    // the double-count the guard exists for: the SAME range again under a new
    // id (what a repeated merge/duplicate re-import produces) → skipped
    const exactDup = await call(b.jar, 'POST', '/import', {
      mode: 'merge',
      data: { tasks: [], sessions: [mk(ulid(), sP + 10_000, sP + 20_000)] },
    });
    check(
      'an exact same-range duplicate is skipped',
      exactDup.body?.summary?.sessions?.skipped === 1,
      JSON.stringify(exactDup.body?.summary?.sessions),
    );
    const afterExact = await bMinutes();
    check(
      'exact-duplicate skip did not double-count',
      afterExact === afterOverlaps,
      `${afterOverlaps} → ${afterExact} min`,
    );
  }

  // ---------- scenario 4: goals survive export → import (F19) -------------
  {
    const exp = await call(a.jar, 'GET', '/export');
    check(
      'export carries a goals collection',
      Array.isArray(exp.body?.goals) && exp.body.goals.length === 1,
      JSON.stringify(exp.body?.goals),
    );
    const exportedGoal = exp.body?.goals?.[0];
    check(
      'the exported goal is A’s, shape included, user_id not leaked in',
      exportedGoal?.id === gA && exportedGoal?.name === 'a-focus' && !('user_id' in (exportedGoal ?? {})),
      JSON.stringify(exportedGoal),
    );

    // duplicate mode: the goal duplicates with a NEW id and its scope refs are
    // remapped onto the duplicated task
    const dup = await call(a.jar, 'POST', '/import', { mode: 'duplicate', data: exp.body });
    check(
      'duplicate-mode import creates one goal',
      dup.status === 200 && dup.body?.summary?.goals?.created === 1,
      `status ${dup.status} ${JSON.stringify(dup.body?.summary?.goals)}`,
    );
    const prog = await call(a.jar, 'GET', '/goals/progress');
    const goals = prog.body?.goals ?? [];
    check('goal count doubled', goals.length === 2, `${goals.length} goals`);
    const boot = await call(a.jar, 'GET', '/bootstrap');
    const aLiveTasks = new Set((boot.body?.tasks ?? []).map((t) => t.id));
    const dupGoal = goals.find((g) => g.goal?.id !== gA)?.goal;
    const refTask = String(dupGoal?.scope?.[0] ?? '').split(':')[1];
    check(
      'the duplicated goal’s scope points at the duplicated task',
      !!refTask && aLiveTasks.has(refTask),
      `scope ref task: ${refTask}`,
    );
    check(
      'the duplicated goal keeps its shape',
      dupGoal?.name === 'a-focus' && dupGoal?.target_minutes === 30 && dupGoal?.period === 'day',
      JSON.stringify(dupGoal),
    );

    // merge re-import of the same export → the original goal updates, count stays
    const merge = await call(a.jar, 'POST', '/import', { mode: 'merge', data: exp.body });
    check(
      'merge re-import updates the original goal',
      merge.body?.summary?.goals?.updated === 1 && merge.body?.summary?.goals?.created === 0,
      JSON.stringify(merge.body?.summary?.goals),
    );
    const prog2 = await call(a.jar, 'GET', '/goals/progress');
    check(
      'goal count unchanged after merge re-import',
      (prog2.body?.goals ?? []).length === 2,
      `${(prog2.body?.goals ?? []).length} goals`,
    );
  }
}

await main();
console.log(fail ? '\nimport-auth test FAILED' : '\nimport-auth test passed');
process.exit(fail);
