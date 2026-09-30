// INV-03: a user cannot create overlapping manual sessions on the same task
// when the overlap is forbidden — even when two requests arrive at once.
//
// The route used to SELECT the conflicts, then INSERT. Two concurrent requests
// both saw "no overlap" and both inserted; the sequential 409 e2e case could
// never see it. The overlap predicate and the per-account session cap now live
// inside the INSERT/UPDATE statement (D1 serializes writes per database, so a
// guarded single statement cannot be raced), and this script races them for
// real: N rounds × M simultaneous identical-interval creates, then reads the
// rows back and asserts that exactly one survived each round. It also pins the
// boundary behaviour the guard must NOT get wrong: a partially-overlapping
// interval is refused, an abutting one is accepted (the predicate is half-open),
// and the overlap stays per-user.
import { withProxyRetry } from './support/proxy-retry.mjs';
const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787/api';
const ORIGIN = new URL(BASE).origin;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
/** What smoke-test.sh bootstraps the admin credential to (its own default). */
const SUITE_ADMIN_PASSWORD = 'purple-marmalade-admin-42';
const ROUNDS = Number(process.env.TK_ROUNDS ?? 12);
const WIDTH = Number(process.env.TK_WIDTH ?? 6); // simultaneous creates per round

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
      'x-device-id': jar.device ?? 'race',
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

/**
 * `wrangler dev`'s local proxy intermittently answers a dropped request with an
 * HTTP 500 and no body (AGENTS.md). A local artifact, not a product behavior —
 * and in a script whose subject IS concurrency, a dropped request would read as a
 * lost race. Retry it.
 */
async function call(jar, method, path, data) {
  return withProxyRetry(`${method} ${path}`, () => callOnce(jar, method, path, data));
}

const PASS = 'a-very-long-race-password-123';

async function makeUser(admin, name) {
  const created = await call(admin, 'POST', '/admin/users', { username: name, password: PASS });
  if (created.status !== 201) throw new Error(`could not create ${name}: ${created.status}`);
  const jar = { cookies: [] };
  await call(jar, 'POST', '/auth/login', { identifier: name, password: PASS });
  const changed = await call(jar, 'POST', '/me/password', {
    current_password: PASS,
    password: `${PASS}-work`,
  });
  if (changed.status !== 200) throw new Error(`could not clear the password gate for ${name}`);
  return { jar, name, pass: `${PASS}-work` };
}

/** Sessions on `taskId` overlapping [start, end), read back from the API. */
async function sessionsInWindow(jar, taskId, start, end) {
  const res = await call(jar, 'GET', `/sessions?task_id=${taskId}&from=${start}&to=${end + 1}`);
  if (res.status !== 200) throw new Error(`session list failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body?.sessions ?? []).filter((s) => s.started_at < end && (s.ended_at ?? Date.now()) > start);
}

async function main() {
  const admin = { cookies: [] };
  // F5: the seeded admin credential no longer exists (migration 0012 nulled
  // it) — smoke-test.sh bootstraps the admin via `npm run admin:create`, so
  // one of the two known suite passwords must work.
  let login = null;
  for (const pw of [ADMIN_PASSWORD, SUITE_ADMIN_PASSWORD].filter(Boolean)) {
    login = await call(admin, 'POST', '/auth/login', { identifier: 'admin', password: pw });
    if (login.status === 200) break;
  }
  if (!login || login.status !== 200) {
    console.error(
      `race test: admin login failed (${login?.status}) — run smoke-test.sh first (it bootstraps the admin credential via admin:create)`,
    );
    process.exit(1);
  }

  const stamp = Date.now().toString(36).slice(-6);
  const a = await makeUser(admin, `ra${stamp}`);
  const b = await makeUser(admin, `rb${stamp}`);

  // ---------- INV-03: concurrent overlapping manual sessions ----------
  console.log(`== ${ROUNDS} rounds x ${WIDTH} simultaneous overlapping creates ==`);
  const project = await call(a.jar, 'POST', '/projects', { name: `race-${stamp}` });
  const pid = project.body?.project?.id;
  check('project created', !!pid, `status ${project.status}`);
  const task = await call(a.jar, 'POST', `/projects/${pid}/tasks`, { name: 'overlap target' });
  const tid = task.body?.task?.id;
  check('task created', !!tid, `status ${task.status}`);

  // Window layout. checkSessionTimes requires started_at >= the account's
  // created_at and ended_at <= now, and this account was created moments ago,
  // so every window has to be carved out of the sliver between "this account was
  // created" and "now" — which is why the layout is derived from GET /me
  // instead of fixed epoch values. Each round takes its own slot, so a round
  // never touches the previous round's interval and the row count is a clean
  // assertion.
  const me = await call(a.jar, 'GET', '/me');
  const createdAt = me.body?.user?.created_at ?? Date.now();
  const WIN = 200; // window length — any positive gap makes intervals overlap
  let cursor = createdAt + 1;
  /** The next unused [start, end] slot, kept strictly in the past. */
  const slot = () => {
    const start = cursor;
    const end = start + WIN;
    cursor = end + 1; // a 1ms gap, so the next slot does not overlap this one
    return { start, end };
  };
  const rounds = Math.max(1, Math.min(ROUNDS, Math.floor((Date.now() - cursor) / (WIN * 4))));
  if (rounds < ROUNDS) console.log(`  (only ${rounds} round(s) fit between account creation and now)`);
  console.log(`== ${rounds} rounds x ${WIDTH} simultaneous overlapping creates ==`);
  let multiWinner = 0;
  let rowsSeen = 0;
  for (let r = 0; r < rounds; r++) {
    const { start, end } = slot();
    // one jar + device id per racer, so nothing in the stack can dedupe them
    const attempts = Array.from({ length: WIDTH }, (_, i) =>
      call({ cookies: [...a.jar.cookies], csrf: a.jar.csrf, device: `race-${r}-${i}` }, 'POST', '/sessions', {
        task_id: tid,
        started_at: start,
        ended_at: end,
        note: `race-${i}`,
      }),
    );
    const results = await Promise.all(attempts);
    const created = results.filter((x) => x.status === 201).length;
    const conflicts = results.filter((x) => x.status === 409).length;
    const other = results.filter((x) => x.status !== 201 && x.status !== 409);
    if (other.length)
      console.log(`  round ${r}: unexpected ${other.map((o) => `${o.status} ${JSON.stringify(o.body)}`).join(' | ')}`);
    const rows = await sessionsInWindow(a.jar, tid, start, end);
    rowsSeen += rows.length;
    if (rows.length > 1) console.log(`  round ${r}: ${rows.length} overlapping rows exist — INV-03 broken`);
    if (created > 1) multiWinner++;
    if (created === 0) console.log(`  round ${r}: nothing created (${conflicts} conflicts)`);
  }
  check('never more than one session accepted per round', multiWinner === 0, `${multiWinner} round(s) accepted 2+`);
  check('exactly one row survives each round', rowsSeen === rounds, `${rowsSeen} rows over ${rounds} rounds`);

  // ---------- INV-03b: a partially-overlapping interval is still refused ----------
  {
    const { start, end } = slot();
    const first = await call(a.jar, 'POST', '/sessions', { task_id: tid, started_at: start, ended_at: end });
    // starts inside the first session and runs past its end
    const overlap = await call(a.jar, 'POST', '/sessions', {
      task_id: tid,
      started_at: end - Math.floor(WIN / 2),
      ended_at: end + WIN,
    });
    check('the first interval is accepted', first.status === 201, `status ${first.status}`);
    check('a partially-overlapping interval is refused with 409', overlap.status === 409, `status ${overlap.status}`);
    const rows = await sessionsInWindow(a.jar, tid, start, end + WIN);
    check('only the first row exists', rows.length === 1, `${rows.length} rows`);
  }

  // ---------- INV-03c: the sequential path still works (no false positives) ----------
  {
    // abuts the interval above exactly. The predicate is half-open
    // (a.start < b.end AND a.end > b.start), so sharing an endpoint is NOT an
    // overlap and must be accepted — the guard must not over-reject.
    const abutting = cursor - 1;
    const res = await call(a.jar, 'POST', '/sessions', {
      task_id: tid,
      started_at: abutting,
      ended_at: abutting + WIN,
    });
    check('an abutting (non-overlapping) interval is accepted', res.status === 201, `status ${res.status}`);
    cursor = abutting + WIN + 1;
  }

  // ---------- INV-03d: a private task is invisible to another user ----------
  {
    const { start, end } = slot();
    const other = await call(b.jar, 'POST', '/sessions', { task_id: tid, started_at: start, ended_at: end });
    check(
      "another user cannot log time on someone else's private task",
      other.status === 404,
      `status ${other.status}`,
    );
  }

  // Cross-user overlap on a SHARED task is covered by e2e/social-test.sh (its
  // "simultaneous timer/start on a group task" case) — the group invite +
  // group-project dance is that script's job, and duplicating it here would
  // only add a second thing to keep in sync.

  // The group/member capacity guards (INV-04) are NOT re-proved here: they are
  // already enforced inside the INSERT (`WHERE (SELECT COUNT(*) …) < :cap` plus
  // a meta.changes check — routes/groups.ts, routes/friends.ts), which is the
  // shape this change applied to the session insert. Filling an account to its
  // 50-group cap over HTTP would cost ~50 sequential requests to re-prove a
  // guard that is structurally correct.
}

await main();
console.log(fail ? '\nrace test FAILED' : '\nrace test passed');
process.exit(fail);
