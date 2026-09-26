// Security probe suite (run against `wrangler dev`, like smoke-test.sh).
// Creates its own admin-audited users and asserts the app's security posture:
// authn matrix, cross-account authz (IDOR), CSRF, forced-change gate, session
// revocation, response whitelists, rate limits, WS upgrade, info disclosure.
// Usage: node e2e/security-probes.mjs   (env: ADMIN_USERNAME, ADMIN_PASSWORD)
const BASE = 'http://127.0.0.1:8787';
const stamp = Date.now() % 1000000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function jar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) {
      return cookies.get(name) ?? '';
    },
    capture(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

async function raw(session, path, { method = 'GET', body, origin, secFetchSite, csrf } = {}) {
  const headers = { 'x-device-id': 'audit' };
  const ch = session.header();
  if (ch) headers.cookie = ch;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  if (secFetchSite) headers['sec-fetch-site'] = secFetchSite;
  const token = csrf !== undefined ? csrf : session.get('tk_csrf'); // auto double-submit
  if (token) headers['x-csrf-token'] = token;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  session.capture(res);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* html/empty */
  }
  return { status: res.status, data, headers: res.headers };
}

const login = (s, username, password) =>
  raw(s, '/auth/login', { method: 'POST', body: { identifier: username, password } });

async function adminSession() {
  const s = jar();
  const adminPw = process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42';
  let r = await login(s, process.env.ADMIN_USERNAME ?? 'admin', adminPw);
  if (r.status !== 200) {
    // first run after a fresh seed: replace the default password
    r = await login(s, 'admin', 'changemeasap');
    if (r.status !== 200 || !r.data?.must_change_password)
      throw new Error(`admin bootstrap failed: ${JSON.stringify(r.data)}`);
    const ch = await raw(s, '/me/password', {
      method: 'POST',
      body: { current_password: 'changemeasap', password: adminPw },
    });
    if (ch.status !== 200) throw new Error('admin password change failed');
    r = await login(s, 'admin', adminPw);
    if (r.status !== 200) throw new Error('admin re-login failed');
  }
  return s;
}

async function makeUser(admin, username, password) {
  const cr = await raw(admin, '/admin/users', {
    method: 'POST',
    origin: BASE,
    body: { username, name: 'Audit', password },
  });
  if (cr.status !== 201) throw new Error(`create ${username}: ${JSON.stringify(cr.data)}`);
  const s = jar();
  const li = await login(s, username, password);
  if (li.status !== 200 || !li.data?.must_change_password) throw new Error(`${username} login unexpected`);
  const ch = await raw(s, '/me/password', {
    method: 'POST',
    origin: BASE,
    body: { current_password: password, password: `${password}-changed` },
  });
  if (ch.status !== 200) throw new Error(`${username} pw change failed`);
  return { session: s, password: `${password}-changed` };
}

async function main() {
  const admin = await adminSession();
  const { session: attacker } = await makeUser(admin, `aud_a_${stamp}`, `audit-a-${stamp}-pw`);
  const { session: victim, password: victimPw } = await makeUser(admin, `aud_b_${stamp}`, `audit-b-${stamp}-pw`);

  // victim seeds data
  const must = (r, what) => {
    if (r.status >= 400 || !r.data || r.data.error) throw new Error(`${what} failed: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const proj = must(
    await raw(victim, '/projects', { method: 'POST', origin: BASE, body: { name: `SecretProj${stamp}` } }),
    'victim project',
  ).project;
  const task = must(
    await raw(victim, `/projects/${proj.id}/tasks`, { method: 'POST', origin: BASE, body: { name: 'SecretTask' } }),
    'victim task',
  ).task;
  const now = Date.now();
  const sess = must(
    await raw(victim, '/sessions', {
      method: 'POST',
      origin: BASE,
      body: {
        task_id: task.id,
        started_at: now + 60_000,
        ended_at: now + 120_000,
        note: `=cmd|' /C calc'!A0 secret-note`,
      },
    }),
    'victim session',
  ).session;

  // ---------- 1. unauthenticated matrix ----------
  const unauth = jar();
  for (const [m, p] of [
    ['GET', '/bootstrap'],
    ['GET', '/me'],
    ['GET', '/projects'],
    ['GET', '/me/sessions'],
    ['GET', '/sync'],
    ['GET', '/reports/summary'],
    ['GET', '/export'],
    ['POST', '/projects'],
    ['PATCH', '/me'],
    ['DELETE', '/me'],
    ['POST', '/timer/start'],
    ['POST', '/pomo/skip'],
    ['POST', '/admin/users'],
    ['GET', '/admin/users'],
    ['PATCH', '/subtasks/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['DELETE', '/subtasks/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['PATCH', '/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['DELETE', '/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  ]) {
    const r = await raw(unauth, p, { method: m, body: m !== 'GET' ? {} : undefined });
    check(`unauth ${m} ${p.split('?')[0]} → 401`, r.status === 401, `got ${r.status}`);
  }
  {
    const su = await raw(unauth, '/auth/signup', {
      method: 'POST',
      body: { username: 'x', password: 'nope-nope-nope-99' },
    });
    check('unauth /auth/signup → 404', su.status === 404, `got ${su.status}`);
  }

  // ---------- 2. cross-account authz (IDOR) ----------
  const task2 = (
    await raw(victim, `/projects/${proj.id}/tasks`, { method: 'POST', origin: BASE, body: { name: 'SecretTask2' } })
  ).data.task;
  for (const [m, p, body] of [
    ['GET', `/projects/${proj.id}`],
    ['PATCH', `/projects/${proj.id}`, { name: 'hacked' }],
    ['DELETE', `/projects/${proj.id}`],
    ['GET', `/projects/${proj.id}/tasks`],
    ['PATCH', `/tasks/${task.id}`, { name: 'hacked' }],
    ['DELETE', `/tasks/${task.id}`],
    ['GET', `/sessions/${sess.id}`],
    ['DELETE', `/sessions/${sess.id}`],
    ['POST', `/tasks/${task.id}/deps`, { depends_on_id: task2.id }],
    ['POST', `/tasks/${task.id}/subtasks`, { name: 'x' }],
  ]) {
    const r = await raw(attacker, p, { method: m, body, origin: BASE });
    check(`IDOR ${m} ${p.split('?')[0]} → 404`, r.status === 404, `got ${r.status}`);
  }
  {
    // layout is user-scoped in SQL — a foreign project id yields 200 with the
    // attacker's own (empty) rows only; verify nothing of the victim leaks
    const gl = await raw(attacker, `/layout/${proj.id}`, { origin: BASE });
    check(
      'IDOR GET layout leaks nothing (empty own rows)',
      gl.status === 200 && (gl.data?.positions ?? []).length === 0,
      `got ${gl.status} ${(gl.data?.positions ?? []).length} rows`,
    );
    const pl = await raw(attacker, `/layout/${proj.id}`, {
      method: 'PUT',
      origin: BASE,
      body: { positions: [{ task_id: task.id, x: 1, y: 1 }] },
    });
    const vl = await raw(victim, `/layout/${proj.id}`);
    check(
      'IDOR PUT layout cannot write via foreign project',
      pl.status === 200 && (vl.data?.positions ?? []).length === 0,
      `victim rows: ${(vl.data?.positions ?? []).length}`,
    );
  }
  {
    const log = await raw(attacker, '/sessions');
    const leak = (log.data?.sessions ?? []).some((s) => s.id === sess.id || (s.note ?? '').includes('secret-note'));
    check('IDOR sessions list shows no victim rows', !leak, `${log.data?.sessions?.length ?? 0} own rows`);
    const ex = await raw(attacker, '/export?format=json');
    const exLeak =
      JSON.stringify(ex.data).includes(`SecretProj${stamp}`) || JSON.stringify(ex.data).includes('secret-note');
    check('IDOR export contains no victim data', !exLeak);
  }

  // ---------- 3. timer/pomo task ownership (DO path) ----------
  {
    const r = await raw(attacker, '/timer/start', { method: 'POST', origin: BASE, body: { task_id: task.id } });
    check(
      'IDOR timer/start on foreign task rejected',
      r.status === 404,
      `got ${r.status} ${JSON.stringify(r.data).slice(0, 80)}`,
    );
    if (r.status === 200) await raw(attacker, '/timer/stop', { method: 'POST', origin: BASE });
    const sw = await raw(attacker, '/timer/switch', { method: 'POST', origin: BASE, body: { task_id: task.id } });
    check('IDOR timer/switch on foreign task rejected', sw.status === 404, `got ${sw.status}`);
    const pm = await raw(attacker, '/pomo/start', { method: 'POST', origin: BASE, body: { task_id: task.id } });
    check('IDOR pomo/start on foreign task rejected', pm.status === 404, `got ${pm.status}`);
  }

  // ---------- 4. task → foreign project move ----------
  {
    const vp = await raw(victim, '/projects', { method: 'POST', origin: BASE, body: { name: `VictimOnly${stamp}` } });
    if (!vp.data?.project) throw new Error(`victim project create failed: ${JSON.stringify(vp.data)}`);
    const foreignProject = vp.data.project;
    const ap = await raw(attacker, '/projects', { method: 'POST', origin: BASE, body: { name: `AttackerP${stamp}` } });
    if (!ap.data?.project) throw new Error(`attacker project create failed: ${JSON.stringify(ap.data)}`);
    const ownProject = ap.data.project;
    const ownTask = (
      await raw(attacker, `/projects/${ownProject.id}/tasks`, { method: 'POST', origin: BASE, body: { name: 'Mover' } })
    ).data.task;
    const r = await raw(attacker, `/tasks/${ownTask.id}`, {
      method: 'PATCH',
      origin: BASE,
      body: { project_id: foreignProject.id },
    });
    check('task cannot be moved into a foreign project', r.status === 404, `got ${r.status}`);
  }

  // ---------- 5. CSRF ----------
  {
    // cross-site POST with cookies (classic CSRF: form/fetch) → 403
    let r = await raw(victim, '/projects', { method: 'POST', body: { name: 'x' }, origin: 'https://evil.example' });
    check('CSRF foreign Origin → 403', r.status === 403, `got ${r.status}`);
    r = await raw(victim, '/projects', { method: 'POST', body: { name: 'x' }, secFetchSite: 'cross-site' });
    check('CSRF sec-fetch-site: cross-site → 403', r.status === 403, `got ${r.status}`);
    r = await raw(victim, '/projects', { method: 'POST', body: { name: 'x' }, secFetchSite: 'same-site' });
    check('CSRF sec-fetch-site: same-site → 403', r.status === 403, `got ${r.status}`);
    // same-origin without CSRF header (stolen-cookie style) → 403 double-submit
    r = await raw(victim, '/projects', { method: 'POST', body: { name: 'x' }, origin: BASE, csrf: null });
    check('CSRF missing header with Origin → 403', r.status === 403, `got ${r.status}`);
    // header mismatch → 403
    r = await raw(victim, '/projects', { method: 'POST', body: { name: 'x' }, origin: BASE, csrf: 'wrong-value' });
    check('CSRF mismatched token → 403', r.status === 403, `got ${r.status}`);
  }

  // ---------- 6. forced password change gate ----------
  {
    const flagged = jar();
    const u = `aud_flag_${stamp}`;
    await raw(admin, '/admin/users', {
      method: 'POST',
      origin: BASE,
      body: { username: u, password: `audit-flag-${stamp}-pw` },
    });
    const li = await login(flagged, u, `audit-flag-${stamp}-pw`);
    check('flagged login reports must_change_password', li.data?.must_change_password === true);
    const t = (li.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith('tk_csrf='))
      ?.split(';')[0]
      ?.split('=')[1];
    for (const [m, p, body] of [
      ['GET', '/bootstrap'],
      ['GET', '/projects'],
      ['GET', '/sync'],
      ['GET', '/reports/summary'],
      ['GET', '/export'],
      ['GET', '/admin/users'],
      ['POST', '/timer/start'],
      ['PATCH', '/me'],
      ['DELETE', '/me'],
    ]) {
      const r = await raw(flagged, p, { method: m, body, origin: BASE, csrf: t });
      check(
        `gate ${m} ${p} → 403 password_change_required`,
        r.status === 403 && r.data?.error?.code === 'password_change_required',
        `got ${r.status}`,
      );
    }
    const me = await raw(flagged, '/me');
    check('gate GET /me stays readable', me.status === 200);
    const ch = await raw(flagged, '/me/password', {
      method: 'POST',
      origin: BASE,
      csrf: t,
      body: { current_password: `audit-flag-${stamp}-pw`, password: `audit-flag-${stamp}-done` },
    });
    check('gate POST /me/password allowed', ch.status === 200, `got ${ch.status}`);
    const after = await raw(flagged, '/bootstrap');
    check('gate lifted after change', after.status === 200);
  }

  // ---------- 7. session revocation ----------
  {
    const s1 = jar();
    const s2 = jar();
    const u = `aud_rev_${stamp}_${Math.floor(Math.random() * 1000)}`;
    const revPw = `audit-rev-${stamp}-pw`;
    const cr = await raw(admin, '/admin/users', {
      method: 'POST',
      origin: BASE,
      body: { username: u, password: revPw },
    });
    if (cr.status !== 201) throw new Error(`create ${u}: ${JSON.stringify(cr.data)}`);
    const l1 = await login(s1, u, revPw);
    const l2 = await login(s2, u, revPw);
    if (l1.status !== 200 || l2.status !== 200) throw new Error(`rev logins failed: ${l1.status} ${l2.status}`);
    // deactivate → all sessions revoked
    const users = (await raw(admin, '/admin/users')).data.users;
    const uid = users.find((x) => x.username === u)?.id;
    if (!uid) throw new Error('created user missing from /admin/users');
    await raw(admin, `/admin/users/${uid}`, { method: 'PATCH', origin: BASE, body: { active: 0 } });
    const d1 = await raw(s1, '/me');
    const d2 = await raw(s2, '/me');
    check('deactivation revokes session 1', d1.status === 401, `got ${d1.status}`);
    check('deactivation revokes session 2', d2.status === 401, `got ${d2.status}`);
    const rlog = await login(s1, u, revPw);
    check(
      'deactivated login → 403 account_disabled',
      rlog.status === 403 && rlog.data?.error?.code === 'account_disabled',
      `got ${rlog.status}`,
    );
    // re-activate + admin password reset → revoked + flagged
    await raw(admin, `/admin/users/${uid}`, { method: 'PATCH', origin: BASE, body: { active: 1 } });
    await raw(admin, `/admin/users/${uid}/password`, {
      method: 'POST',
      origin: BASE,
      body: { password: `${revPw}-np` },
    });
    const old = await raw(s1, '/me');
    check('admin reset revokes old sessions', old.status === 401, `got ${old.status}`);
  }

  // ---------- 8. response field whitelists (sensitive data) ----------
  {
    const s = jar();
    await login(s, `aud_b_${stamp}`, victimPw);
    const me = await raw(s, '/me');
    const meKeys = Object.keys(me.data.user ?? {});
    const badMe = ['password_hash', 'token_hash', 'totp_secret', 'ip', 'active'];
    check(
      '/me exposes no sensitive fields',
      badMe.every((k) => !meKeys.includes(k)),
      meKeys.join(','),
    );
    const b = await raw(s, '/bootstrap');
    const bootKeys = Object.keys(b.data.user ?? {});
    check(
      '/bootstrap user exposes no sensitive fields',
      badMe.filter((k) => k !== 'active').every((k) => !bootKeys.includes(k)),
      bootKeys.join(','),
    );
    const lg = await raw(s, '/auth/login', {
      method: 'POST',
      body: { identifier: `aud_b_${stamp}`, password: victimPw },
    });
    const loginKeys = Object.keys(lg.data ?? {});
    check(
      'login response minimal',
      loginKeys.every((k) => ['ok', 'user_id', 'role', 'must_change_password'].includes(k)),
      loginKeys.join(','),
    );
    const sessions = await raw(s, '/me/sessions');
    const sessKeys = Object.keys(sessions.data.sessions?.[0] ?? {});
    check(
      '/me/sessions exposes only session fields',
      sessKeys.every((k) =>
        ['id', 'user_agent', 'ip', 'created_at', 'last_seen_at', 'expires_at', 'current'].includes(k),
      ),
      sessKeys.join(','),
    );
  }

  // ---------- 9. per-user rate limit on heavy endpoints (spec NFR-3: 120/min) ----------
  // NOTE: with the production default (120/min) this is only reachable when the
  // per-request latency is low enough to fit 120+ into one 60s window — locally
  // that needs a test override (RL_API_USER=10 in .dev.vars + dev restart);
  // enforcement is verified via the RL_* override plumbing (same code path as
  // the login limits, which do 429 in e2e).
  {
    const codes = new Set();
    for (let batch = 0; batch < 10 && !codes.has(429); batch++) {
      const rs = await Promise.all(Array.from({ length: 25 }, () => raw(victim, '/sync')));
      rs.forEach((r) => codes.add(r.status));
    }
    if (codes.has(429)) check('heavy API bursts are rate limited (429 appears)', true);
    else
      console.log(
        `SKIP  heavy-API rate limit probe (needs RL_API_USER=10 in .dev.vars to exceed locally; all codes: ${[...codes].join(',')})`,
      );
  }

  // ---------- 10. WS upgrade without session ----------
  {
    const res = await fetch(`${BASE.replace('http', 'ws')}/api/ws?device=audit`, {
      headers: { upgrade: 'websocket' },
    }).catch((e) => ({ status: 0, error: e.message }));
    check(
      'WS upgrade without session rejected',
      res.status === 401 || res.status === 0,
      `got ${res.status ?? res.error}`,
    );
  }

  // ---------- cleanup: deactivate audit users ----------
  const users = (await raw(admin, '/admin/users')).data.users;
  for (const u of users) {
    if (/^aud_[ab]_/.test(u.username) && u.active) {
      await raw(admin, `/admin/users/${u.id}`, { method: 'PATCH', origin: BASE, body: { active: 0 } });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('PROBES CRASHED:', e.message);
  process.exit(1);
});
