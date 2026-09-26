// Undo/restore round-trip (FR-T4): build a task with subtask + dep + session,
// delete it (capturing the undo payload), POST /restore, verify identical rows.
const BASE = 'http://127.0.0.1:8787';

async function raw(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    headers: { 'content-type': 'application/json', cookie, 'x-device-id': 'undo-test', ...(opts.headers ?? {}) },
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

async function main() {
  const login = await raw('/auth/login', {
    method: 'POST',
    body: { identifier: 'dana', password: 'purple-marmalade-tuesday' },
  });
  const ck = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const boot = (await raw('/bootstrap', {}, ck)).body;
  const proj = boot.projects[0];

  // fixture: task + subtask + dep + manual session
  const task = (
    await raw(`/projects/${proj.id}/tasks`, { method: 'POST', body: { name: `UndoMe-${Date.now() % 10000}` } }, ck)
  ).body.task;
  const sb = (await raw(`/tasks/${task.id}/subtasks`, { method: 'POST', body: { name: 'checklist item' } }, ck)).body
    .subtask;
  const anchor = boot.tasks.find((t) => t.id !== task.id);
  await raw(`/tasks/${task.id}/deps`, { method: 'POST', body: { depends_on_id: anchor.id } }, ck); // UndoMe depends on anchor
  const now = Date.now();
  const sessRes = await raw(
    '/sessions',
    {
      method: 'POST',
      body: { task_id: task.id, started_at: now + 60_000, ended_at: now + 240_000, note: 'undo me' },
    },
    ck,
  );
  if (sessRes.status !== 201) {
    console.error('fixture session create failed:', JSON.stringify(sessRes.body));
    process.exit(1);
  }
  console.log(`fixture: task ${task.name}, 1 subtask, 1 dep, 1 session`);

  // delete → capture undo payload
  const del = await raw(`/tasks/${task.id}`, { method: 'DELETE' }, ck);
  console.log('delete:', del.status, '| undo payload:', !!del.body.undo);
  if (del.status !== 200) process.exit(1);

  // undo
  const undo = await raw('/restore', { method: 'POST', body: del.body.undo }, ck);
  console.log('restore:', undo.status, JSON.stringify(undo.body));

  const after = (await raw('/bootstrap', {}, ck)).body;
  const t2 = after.tasks.find((t) => t.id === task.id);
  const sb2 = after.subtasks.find((s) => s.id === sb.id);
  const dep2 = after.dependencies.find((d) => d.task_id === task.id && d.depends_on_id === anchor.id);
  const log = (await raw(`/sessions?task_id=${task.id}`, {}, ck)).body.sessions;
  const ok = !!t2 && !!sb2 && !!dep2 && log.length === 1 && log[0].note === 'undo me';
  console.log(
    `after undo — task:${!!t2} subtask(id kept):${!!sb2} dep:${!!dep2} session(note matched):${log.length === 1}`,
  );
  console.log(ok ? 'PASS: undo restores the identical row set — ids, checklists, deps and sessions intact' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
