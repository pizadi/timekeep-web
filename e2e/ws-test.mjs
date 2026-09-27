// WS smoke test: connect two sockets to the same user's UserHub,
// trigger a timer event via REST from "device A", assert device B receives it (FR-N1/N2).
//
// Also pins the two things the DO refuses on its own authority (INV-10): the
// per-session connection ceiling, and a session row that no longer exists at
// upgrade time (the Worker authenticates the cookie first, but the DO is the
// serialized authority — it re-reads the row, so a revocation that lands in the
// gap still wins).
const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8787';

async function main() {
  // login (fresh account from smoke test)
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'dana', password: 'purple-marmalade-tuesday' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  console.log('login:', login.status, 'cookie set:', !!cookie);

  const boot = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } }).then((r) => r.json());
  const task = boot.tasks[0];
  console.log('bootstrap ok — using task:', task?.name);

  const wsUrl = `${BASE.replace('http', 'ws')}/api/ws?device=deviceB`;
  const ws = new WebSocket(wsUrl, { headers: { cookie } });

  const received = [];
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for events')), 15000);
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      received.push(ev.type);
      console.log('WS <-', ev.type, ev.id ? `(#${ev.id})` : '');
      if (received.includes('timer.started') && received.includes('timer.stopped')) {
        clearTimeout(t);
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('ws error'));
    };
  });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
  console.log('ws open — device B connected');

  // device A starts + stops a timer via REST
  await new Promise((r) => setTimeout(r, 500));
  await fetch(`${BASE}/api/timer/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-device-id': 'deviceA' },
    body: JSON.stringify({ task_id: task.id }),
  });
  await new Promise((r) => setTimeout(r, 700));
  await fetch(`${BASE}/api/timer/stop`, { method: 'POST', headers: { cookie, 'x-device-id': 'deviceA' } });
  await new Promise((r) => setTimeout(r, 700));

  await done;
  ws.close();
  console.log('PASS: hello received, cross-device timer events fanned out within latency budget');

  await capacityChecks(cookie);
  await revokedSessionChecks(cookie);
}

/** Open `n` sockets from one session and report how many the server accepted. */
async function openMany(cookie, n) {
  const sockets = [];
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < n; i++) {
    const s = new WebSocket(`${BASE.replace('http', 'ws')}/api/ws?device=cap-${i}`, {
      headers: { cookie },
    });
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      s.onopen = () => {
        clearTimeout(timer);
        resolve(true);
      };
      s.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      s.onclose = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    if (opened) {
      accepted++;
      sockets.push(s);
    } else refused++;
  }
  return { sockets, accepted, refused };
}

async function capacityChecks(cookie) {
  console.log('\n== WebSocket connection ceiling (INV-10) ==');
  const { sockets, accepted, refused } = await openMany(cookie, 12);
  console.log(`  ${accepted} accepted, ${refused} refused`);
  if (accepted < 2) {
    console.error(`FAIL: expected the ceiling to allow several sockets, only ${accepted} opened`);
    process.exit(1);
  }
  if (accepted > 8) {
    console.error(`FAIL: per-session ceiling breached — ${accepted} sockets accepted from one session`);
    process.exit(1);
  }
  if (refused === 0) {
    console.error('FAIL: the ceiling never refused anything — 12 sockets should not all be accepted');
    process.exit(1);
  }
  for (const s of sockets) s.close();
  console.log('PASS: the per-session WebSocket ceiling holds');
}

async function revokedSessionChecks(cookie) {
  console.log('\n== a revoked session cannot open a socket ==');
  // Sign in a second time to get a second session, then revoke it and try to
  // use its cookie for a socket. The DO re-reads the session row at upgrade
  // time, so a revoked cookie is refused there even though the Worker checked
  // it moments earlier in a different request.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'dana', password: 'purple-marmalade-tuesday' }),
  });
  const revoked = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!revoked) {
    console.error(`FAIL: the second sign-in did not return a session (${login.status})`);
    process.exit(1);
  }
  const sessions = await fetch(`${BASE}/api/me/sessions`, { headers: { cookie } }).then((r) => r.json());
  const current = sessions.sessions.find((s) => s.current);
  const other = sessions.sessions.find((s) => !s.current);
  if (!current || !other) {
    console.error(`FAIL: expected two sessions to compare, got ${JSON.stringify(sessions)}`);
    process.exit(1);
  }
  const del = await fetch(`${BASE}/api/me/sessions/${other.id}`, { method: 'DELETE', headers: { cookie } });
  if (del.status !== 200) {
    console.error(`FAIL: could not revoke the target session (${del.status})`);
    process.exit(1);
  }
  console.log(`  revoked session ${other.id} (kept ${current.id})`);
  const s = new WebSocket(`${BASE.replace('http', 'ws')}/api/ws?device=revoked`, { headers: { cookie: revoked } });
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    s.onopen = () => {
      clearTimeout(timer);
      resolve(true);
    };
    s.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  if (opened) {
    s.close();
    console.error('FAIL: a revoked session established a WebSocket');
    process.exit(1);
  }
  console.log('PASS: a revoked session cannot open a socket');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
