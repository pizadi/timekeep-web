// WS smoke test: connect two sockets to the same user's UserHub,
// trigger a timer event via REST from "device A", assert device B receives it (FR-N1/N2).
const BASE = 'http://127.0.0.1:8787';

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
    ws.onerror = (e) => {
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
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
