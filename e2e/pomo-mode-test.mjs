// Verification for pomodoro-mode-as-timer (FR-F0): requires `wrangler dev` running.
// 1. default settings have pomodoro.enabled = false
// 2. plain /timer/start with pomodoro off → session source 'timer', pomo idle
// 3. enabling pomodoro → plain /timer/start engages focus (source 'pomodoro')
// 4. /timer/switch mid-focus re-anchors the cycle (source 'pomodoro')
// 5. /pomo/skip → idle; disabling mid-cycle resets to idle, timer keeps running
// 6. legacy /pomo/start still works with the mode off
const BASE = 'http://127.0.0.1:8787';

async function raw(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', cookie, 'x-device-id': 'pomo-mode-test', ...(opts.headers ?? {}) }
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').split(';')[0];
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const admin = cookieOf(await raw('/auth/login', {
    method: 'POST',
    body: { identifier: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD ?? 'purple-marmalade-admin-42' }
  }));

  // fresh user for a clean slate
  const stamp = Date.now() % 1000000;
  const uname = `pom${stamp}`;
  await raw('/admin/users', { method: 'POST', body: { username: uname, password: 'pomo-temp-passphrase-42' } }, admin);
  const login = await raw('/auth/login', { method: 'POST', body: { identifier: uname, password: 'pomo-temp-passphrase-42' } });
  const ck = cookieOf(login);
  await raw('/me/password', { method: 'POST', body: { current_password: 'pomo-temp-passphrase-42', password: 'pomo-secure-passphrase-42' } }, ck);

  const boot = (await raw('/bootstrap', {}, ck)).body;
  check('default settings: pomodoro.enabled false', boot.settings?.pomodoro?.enabled === false, JSON.stringify(boot.settings?.pomodoro));

  // project + task
  const proj = (await raw('/projects', { method: 'POST', body: { name: 'PomoMode' } }, ck)).body.project;
  const t1 = (await raw(`/projects/${proj.id}/tasks`, { method: 'POST', body: { name: 'task one' } }, ck)).body.task;
  const t2 = (await raw(`/projects/${proj.id}/tasks`, { method: 'POST', body: { name: 'task two' } }, ck)).body.task;

  // 2. plain start, pomodoro off
  const start1 = await raw('/timer/start', { method: 'POST', body: { task_id: t1.id } }, ck);
  check('pomodoro OFF: plain start → source "timer"', start1.body?.session?.source === 'timer', JSON.stringify(start1.body?.session));
  check('pomodoro OFF: pomo stays idle', start1.body?.pomo?.phase === 'idle', `phase=${start1.body?.pomo?.phase}`);
  await raw('/timer/stop', { method: 'POST' }, ck);

  // 3. enable pomodoro mode
  const setRes = await raw('/settings', { method: 'PUT', body: { pomodoro: { enabled: true } } }, ck);
  check('settings PUT accepts pomodoro.enabled', setRes.status === 200 && setRes.body?.settings?.pomodoro?.enabled === true);

  const start2 = await raw('/timer/start', { method: 'POST', body: { task_id: t1.id } }, ck);
  check('pomodoro ON: plain start → source "pomodoro"', start2.body?.session?.source === 'pomodoro', JSON.stringify(start2.body?.session));
  check('pomodoro ON: plain start → focus phase', start2.body?.pomo?.phase === 'focus', `phase=${start2.body?.pomo?.phase}`);
  check('pomodoro ON: cycle anchored to task', start2.body?.pomo?.taskId === t1.id);

  // 4. switch mid-focus
  const sw = await raw('/timer/switch', { method: 'POST', body: { task_id: t2.id } }, ck);
  check('pomodoro ON: switch → new session source "pomodoro"', sw.body?.started?.source === 'pomodoro', JSON.stringify(sw.body?.started));
  check('pomodoro ON: switch re-anchors cycle', sw.body?.pomo?.taskId === t2.id, `taskId anchored=${sw.body?.pomo?.taskId === t2.id}`);

  // 5. skip → idle (timer keeps running — FR-F4 "logs nothing"); stop, then
  // start once more while still enabled, then disable mid-cycle
  const skip = await raw('/pomo/skip', { method: 'POST' }, ck);
  check('skip → idle', skip.body?.pomo?.phase === 'idle');

  await raw('/timer/stop', { method: 'POST' }, ck);
  await raw('/timer/start', { method: 'POST', body: { task_id: t1.id } }, ck);
  const off = await raw('/settings', { method: 'PUT', body: { pomodoro: { enabled: false } } }, ck);
  console.log('  [dbg] disable response:', off.status, JSON.stringify(off.body).slice(0, 200));
  check('disable accepts', off.status === 200 && off.body?.settings?.pomodoro?.enabled === false);
  await new Promise((r) => setTimeout(r, 300)); // let the DO /notify land
  const timerState = (await raw('/timer', {}, ck)).body;
  check('disable mid-cycle → pomo reset to idle', timerState?.pomo?.phase === 'idle', `phase=${timerState?.pomo?.phase}`);
  check('disable mid-cycle → timer keeps running (never auto-stops)', !!timerState?.session);
  await raw('/timer/stop', { method: 'POST' }, ck);

  // sources in the log: 1× timer (mode off) + 3× pomodoro (enabled starts + switch)
  const log = (await raw('/sessions', {}, ck)).body;
  console.log('  [dbg] sessions:', log.sessions.map((s) => `${s.source}@${new Date(s.started_at).toISOString().slice(11, 19)}`).join(' | '));
  const sources = log.sessions.map((s) => s.source).sort().join(',');
  check('log sources = timer + 3× pomodoro', sources === 'pomodoro,pomodoro,pomodoro,timer', sources);

  // 6. legacy /pomo/start still works when disabled → 'pomodoro' source on explicit start
  const legacy = await raw('/pomo/start', { method: 'POST', body: { task_id: t1.id } }, ck);
  check('legacy /pomo/start with mode off → focus', legacy.body?.pomo?.phase === 'focus');
  const legacySess = (await raw('/timer', {}, ck)).body?.session;
  check('legacy /pomo/start → source "pomodoro"', legacySess?.source === 'pomodoro');
  await raw('/timer/stop', { method: 'POST' }, ck);
  await raw('/pomo/skip', { method: 'POST' }, ck);

  console.log(failures === 0 ? 'ALL POMODORO-MODE CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
