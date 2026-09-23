// Focused checks for the page-based log pagination, the /reports/day daily
// summary and the subtask-level donut breakdown. Run smoke-test.sh first —
// this script reuses its accounts (dana has sessions from that run).
const BASE = 'http://127.0.0.1:8787';

async function raw(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', cookie, 'x-device-id': 'pg-test', ...(opts.headers ?? {}) }
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok —', msg); };

async function main() {
  const cookie = cookieOf(await raw('/auth/login', {
    method: 'POST', body: { identifier: 'dana', password: 'purple-marmalade-tuesday' }
  }));
  assert(!!cookie, 'login (dana, from smoke-test.sh)');

  // --- page-based pagination ---
  const p1 = await raw('/sessions?page=1&page_size=5', {}, cookie);
  assert(p1.status === 200 && Array.isArray(p1.body.sessions) && p1.body.sessions.length <= 5,
    `page 1 returns ≤5 rows (${p1.body.sessions?.length})`);
  assert(Number.isInteger(p1.body.total) && p1.body.total >= p1.body.sessions.length,
    `total present (${p1.body.total})`);
  assert(p1.body.page === 1 && p1.body.page_size === 5, 'page/page_size echoed');
  const p2 = await raw('/sessions?page=2&page_size=5', {}, cookie);
  if (p1.body.total > 5) {
    const ids1 = new Set(p1.body.sessions.map((s) => s.id));
    assert(p2.body.sessions.every((s) => !ids1.has(s.id)), 'pages are disjoint');
  } else {
    assert(p2.body.sessions.length === 0, 'single page of data → page 2 empty');
  }
  const clamped = await raw('/sessions?page=0&page_size=99999', {}, cookie);
  assert(clamped.status === 200 && clamped.body.page === 1, 'page=0 clamps to 1');
  assert(clamped.body.page_size <= 200, 'page_size clamps to LIMITS.logPageSize');

  // --- daily summary ---
  const day = await raw('/reports/day', {}, cookie);
  assert(day.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(day.body.day),
    `day summary defaults to today (${day.body.day})`);
  assert(Number.isInteger(day.body.total_minutes) && Array.isArray(day.body.projects) && Array.isArray(day.body.tasks),
    `day totals + buckets present (${day.body.total_minutes}m, ${day.body.projects.length} projects, ${day.body.tasks.length} tasks)`);
  const picked = day.body.tasks[0];
  if (picked) {
    const sum = picked.minutes + picked.subtasks.reduce((a, s) => a + s.minutes, 0);
    assert(Math.abs(sum - picked.total_minutes) <= 1,
      `task "${picked.task_name}": task remainder + subtasks ≈ total (${sum}/${picked.total_minutes})`);
    const total = day.body.projects.reduce((a, p) => a + p.minutes, 0);
    assert(Math.abs(total - day.body.total_minutes) <= day.body.projects.length,
      `per-project minutes sum to the day total (${total}/${day.body.total_minutes})`);
  }
  const explicit = await raw(`/reports/day?date=${day.body.day}`, {}, cookie);
  assert(explicit.body.day === day.body.day, 'explicit date param accepted');
  const badDate = await raw('/reports/day?date=not-a-date', {}, cookie);
  assert(badDate.status === 200 && badDate.body.day === day.body.day, 'invalid date falls back to today');

  // --- summary carries the subtask donut breakdown ---
  const sum = await raw(`/reports/summary?from=${day.body.day}&to=${day.body.day}`, {}, cookie);
  assert(sum.status === 200 && Array.isArray(sum.body.donut_subtasks), 'summary carries donut_subtasks[]');
  assert(sum.body.donut_subtasks.every((d) => typeof d.task_name === 'string' && Number.isInteger(d.minutes)),
    'donut_subtasks rows shaped (task_name, minutes)');
  console.log('ALL FOCUSED CHECKS PASSED');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
