// Per-user write throttle (audit 🟠1): the CRUD/task/session/timer/group routes
// used to have no rate limit at all — only eventual entity-count caps.
//
// Runs against a DEDICATED wrangler dev instance (own port, own D1 state) that
// run-e2e.sh starts with a small RL_WRITE_USER. Two reasons:
//  - the seeded admin is forced to rotate its password on first use, and that
//    instance is disposable (the shared :8787 one is not — its admin password
//    is already rotated by smoke-test.sh),
//  - a burst big enough to trip the 300/min default would take minutes through
//    the local dev proxy, which has a ~0.5 s/request baseline. The limit is a
//    config value; what needs proving is the mechanism.
const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8788/api';
const ORIGIN = new URL(BASE).origin;
const ADMIN_PASSWORD = 'a-very-long-admin-password-123';
const SEEDED_PASSWORD = 'changemeasap'; // what a fresh migration seeds
// 5, not the 300 default: the local dev proxy answers a write in ~1.2 s, so a
// 300-write burst would take minutes AND straddle the 60 s window (neither
// window exceeding the limit). At 5 the 6th write trips it within ~7 s — fast
// and timing-proof. The default itself is a config value; this proves the
// mechanism. run-e2e.sh starts the instance with --var RL_WRITE_USER:5.
const LIMIT = Number(process.env.RL_WRITE_USER ?? 5);
const BURST = LIMIT + 15; // headroom for skipped local flakes

const USER = `wl${Date.now().toString(36)}`;
const PASS = 'a-very-long-password-123';

let fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail = 1;
}

/** fetch() + cookie jar (the session cookie and the rotating CSRF token). */
async function call(jar, device, method, path, data) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      origin: ORIGIN,
      'x-device-id': device,
      'x-csrf-token': jar.csrf ?? '',
      ...(jar.cookies?.length ? { cookie: jar.cookies.join('; ') } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq),
      value = pair.slice(eq + 1);
    if (name === 'tk_csrf') jar.csrf = value;
    jar.cookies = (jar.cookies ?? []).filter((p) => !p.startsWith(`${name}=`));
    jar.cookies.push(`${name}=${value}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 204 / empty body */
  }
  return { status: res.status, body, headers: res.headers };
}

const adm = { cookies: [] };
const ui = { cookies: [] };

console.log('== admin: sign in, clear the forced-rotate gate, create a throwaway user ==');
let adminIn = await call(adm, 'wl-adm', 'POST', '/auth/login', { identifier: 'admin', password: SEEDED_PASSWORD });
check('admin login (seeded password)', adminIn.status === 200, `status ${adminIn.status}`);
const rotated = await call(adm, 'wl-adm', 'POST', '/me/password', {
  current_password: SEEDED_PASSWORD,
  password: ADMIN_PASSWORD,
});
check('admin password rotated (unlocks the gate)', rotated.status === 200, `status ${rotated.status}`);
const created = await call(adm, 'wl-adm', 'POST', '/admin/users', { username: USER, password: PASS });
check('admin creates user', created.status === 201, `status ${created.status} ${JSON.stringify(created.body)}`);

console.log('== sign in as the throwaway user, clear its own gate ==');
await call(ui, 'wl-ui', 'POST', '/auth/login', { identifier: USER, password: PASS });
const changed = await call(ui, 'wl-ui', 'POST', '/me/password', { current_password: PASS, password: `${PASS}-work` });
check('password gate cleared', changed.status === 200, `status ${changed.status}`);

const proj = await call(ui, 'wl-ui', 'POST', '/projects', { name: 'WL' });
check('first write lands (budget starts here)', proj.status === 201 || proj.status === 200, `status ${proj.status}`);
const pid = proj.body?.project?.id;

console.log(`== fire ${BURST} writes (RL_WRITE_USER is ${LIMIT}/min) ==`);
// `wrangler dev`'s local proxy intermittently answers rapid sequential writes
// with a bodiless 5xx ("Network connection lost" — AGENTS.md). Local artifact,
// not the limiter: skip those instead of failing the run.
let limited = 0,
  made = 0,
  flake = 0,
  hard = 0;
for (let i = 0; i < BURST; i++) {
  const r = await call(ui, 'wl-ui', 'POST', `/projects/${pid}/tasks`, { name: `t${i}` });
  if (r.status === 429) limited++;
  else if (r.status >= 500 && r.body === null) flake++;
  else if (r.status >= 400) {
    hard++;
    console.log(`  unexpected ${r.status}: ${JSON.stringify(r.body)}`);
    if (hard > 3) break;
  } else made++;
}
console.log(`  ${made} created, ${limited} throttled, ${flake} proxy flakes skipped`);
check('the burst gets throttled', limited > 0, `${limited} of ${BURST} responses were 429`);
check('no unexpected client errors', hard === 0, `${hard} unexpected`);

const after = await call(ui, 'wl-ui', 'POST', `/projects/${pid}/tasks`, { name: 'x' });
check('still limited right after the burst', after.status === 429, `status ${after.status}`);
check('the standard rate_limited envelope', after.body?.error?.code === 'rate_limited', JSON.stringify(after.body));
check(
  'a retry-after header is present',
  !!after.headers.get('retry-after'),
  `retry-after=${after.headers.get('retry-after')}`,
);

console.log('== reads are NOT throttled (the SPA polls constantly) ==');
const reads = [];
for (let i = 0; i < 5; i++) reads.push(await call(ui, 'wl-ui', 'GET', '/projects'));
check(
  'GETs still succeed while writes are limited',
  reads.every((r) => r.status === 200),
  `statuses ${reads.map((r) => r.status).join(',')}`,
);

console.log('== a different user is unaffected (per-user buckets) ==');
const other = { cookies: [] };
const otherName = `wl2${Date.now().toString(36)}`;
await call(adm, 'wl-adm', 'POST', '/admin/users', { username: otherName, password: PASS });
await call(other, 'wl-2', 'POST', '/auth/login', { identifier: otherName, password: PASS });
await call(other, 'wl-2', 'POST', '/me/password', { current_password: PASS, password: `${PASS}-work` });
const otherWrite = await call(other, 'wl-2', 'POST', '/projects', { name: 'other' });
check(
  "another user's write is fine",
  otherWrite.status === 201 || otherWrite.status === 200,
  `status ${otherWrite.status}`,
);

console.log(fail ? '\nwrite-limit test FAILED' : '\nwrite-limit test passed');
process.exit(fail);
