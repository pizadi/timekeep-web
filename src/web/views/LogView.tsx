// Session log (FR-S5/S6/S7): chronological, filterable (project/task/range/note),
// page-based pagination (server page size = LIMITS.logPageSize); editor for
// manual add/edit; delete with undo (FR-T4).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore, pushToast, undoableDelete } from '../lib/store';
import { api, ApiError } from '../lib/api';
import { fmtDateTime, fmtClock, toLocalInput, fromLocalInput, parseLocalInput, fmtUtcOffset, localTimeWarning } from '../lib/time';
import { addDaysCivil, dayStartInstant } from '../../shared/time';
import { LIMITS } from '../../shared/constants';
import { useModalA11y } from '../lib/modal';
import Combobox from '../components/Combobox';
import Dropdown, { ColorChip } from '../components/Dropdown';
import { useBreakpoint } from '../lib/responsive';

interface LogRow {
  id: string; task_id: string; subtask_id?: string | null; subtask_name?: string | null;
  started_at: number; ended_at: number | null;
  source: 'timer' | 'manual' | 'pomodoro'; note: string;
  task_name: string; project_name: string; project_color: string;
}

export default function LogView() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const user = useStore((s) => s.user)!;
  const running = useStore((s) => s.running);
  const reportsVersion = useStore((s) => s.reportsVersion);
  const tz = user.timezone;
  const bp = useBreakpoint();

  const [rows, setRows] = useState<LogRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState<Partial<LogRow> | 'new' | null>(null);

  const PAGE_SIZE = LIMITS.logPageSize;

  // debounce the note filter — a request per keystroke would trip the
  // per-user rate limit while typing
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // audit: rapid filter changes could land out of order — a slower older fetch
  // overwrote newer results. A monotonic seq makes stale responses no-ops.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (taskId) params.set('task_id', taskId);
    if (q) params.set('q', q);
    // civil-day boundaries via the shared day engine (DST-correct on
    // 23/25-hour days, unlike a fixed +24h)
    if (from) params.set('from', String(dayStartInstant(from, tz)));
    if (to) params.set('to', String(dayStartInstant(addDaysCivil(to, 1), tz)));
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    try {
      const res = await api<{ sessions: LogRow[]; total: number }>(`/sessions?${params}`);
      if (seq !== loadSeq.current) return; // superseded
      // a delete on the last row of the last page would otherwise show an
      // empty viewport — step back one page instead
      if (res.sessions.length === 0 && page > 1) { setPage(page - 1); return; }
      setRows(res.sessions);
      setTotal(res.total);
    } catch (e: any) {
      if (seq === loadSeq.current) pushToast('error', e.message);
    }
  }, [projectId, taskId, q, from, to, page, tz, PAGE_SIZE]);

  // filter changes reset to page 1 (page itself is a dep of load, so a reset
  // + filter change batch into ONE refetch)
  useEffect(() => { setPage(1); }, [projectId, taskId, q, from, to, reportsVersion]);
  useEffect(() => { void load(); }, [projectId, taskId, q, from, to, page, reportsVersion, load]);

  // heatmap drill-down (FR-R3): "click a day to inspect its sessions"
  useEffect(() => {
    const onFocusDay = (e: Event) => {
      const day = (e as CustomEvent<string>).detail;
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        setFrom(day);
        setTo(day);
      }
    };
    window.addEventListener('tk:focus-day', onFocusDay);
    return () => window.removeEventListener('tk:focus-day', onFocusDay);
  }, []);

  // recovery "Discard (opens editor)" (FR-S3) — prefilled editor request from TimerBar
  useEffect(() => {
    const onEditSession = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      setEditing({
        id: d.id,
        task_id: d.task_id,
        started_at: d.started_at,
        ended_at: d.ended_at,
        source: 'timer',
        note: '',
        task_name: '',
        project_name: '',
        project_color: ''
      });
    };
    window.addEventListener('tk:edit-session', onEditSession);
    return () => window.removeEventListener('tk:edit-session', onEditSession);
  }, []);

  async function del(row: LogRow) {
    try {
      const res = await api<{ undo: any }>(`/sessions/${row.id}`, { method: 'DELETE' });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      store.bumpReports();
      undoableDelete('Session deleted — undo?', res.undo);
    } catch (e: any) { pushToast('error', e.message); }
  }

  // audit: pagination replaced the old "Load more" accumulation (unbounded DOM) —
  // each page renders at most LIMITS.logPageSize rows.

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="card filters-grid">
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Project</span>
          <Dropdown ariaLabel="Filter by project" value={projectId}
            onChange={(v) => { setProjectId(v); setTaskId(''); }}
            options={[
              { value: '', label: 'All projects', icon: '☰' },
              ...projects.map((p) => ({ value: p.id, label: p.name, icon: <ColorChip color={p.color} /> }))
            ]} />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Task</span>
          <Dropdown ariaLabel="Filter by task" value={taskId} onChange={(v) => setTaskId(v)}
            options={[
              { value: '', label: 'All tasks', icon: '☰' },
              ...tasks.filter((t) => !projectId || t.project_id === projectId)
                .map((t) => ({ value: t.id, label: t.name, icon: <ColorChip color={projects.find((p) => p.id === t.project_id)?.color ?? '#888'} /> }))
            ]} />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>From</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>To</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Note search</span>
          <input className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="contains…" />
        </label>
        <button className="btn primary span-2" style={{ justifySelf: 'start' }} onClick={() => setEditing('new')}>＋ Manual session</button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {bp === 'phone' ? (
          // phone: stacked cards — the 8-column table can't fit without hiding text
          <div className="log-cards">
            {rows.map((r) => {
              const isRunning = running?.id === r.id;
              const mins = Math.round(((r.ended_at ?? Date.now()) - r.started_at) / 60000);
              return (
                <div key={r.id} className="log-card" role="button" tabIndex={0}
                  onClick={() => setEditing(r)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setEditing(r); }}>
                  <div className="log-card-head">
                    <span className="chip" style={{ background: r.project_color }} aria-hidden />
                    <span className="grow">{r.task_name}{r.subtask_name ? <span className="muted"> ▸ {r.subtask_name}</span> : ''}</span>
                    {isRunning ? <b style={{ color: 'var(--danger)' }}>+{mins}m</b> : <b>{mins}m</b>}
                  </div>
                  <div className="log-card-meta">
                    <span>{r.project_name}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtDateTime(r.started_at, tz)} → {isRunning ? 'running…' : r.ended_at ? fmtClock(r.ended_at, tz) : '—'}</span>
                    <span className={`badge ${r.source}`}>{r.source}</span>
                  </div>
                  {r.note && <div className="log-card-note">{r.note}</div>}
                  <div className="log-card-actions">
                    <button className="btn ghost small" aria-label={`Edit session on ${r.task_name}`}
                      onClick={(e) => { e.stopPropagation(); setEditing(r); }}>✎ Edit</button>
                    <button className="btn ghost small" aria-label={`Delete session on ${r.task_name}`}
                      disabled={isRunning}
                      onClick={(e) => { e.stopPropagation(); del(r); }}>🗑</button>
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="muted" style={{ textAlign: 'center', padding: 24 }}>No sessions match these filters.</div>
            )}
          </div>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Project</th><th>Task</th><th>Start</th><th>End</th>
                  <th className="num">Duration</th><th>Source</th><th>Note</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isRunning = running?.id === r.id;
                  const mins = Math.round(((r.ended_at ?? Date.now()) - r.started_at) / 60000);
                  return (
                    <tr key={r.id} tabIndex={0}
                      onDoubleClick={() => setEditing(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setEditing(r);
                        if (e.key === 'Delete' && !isRunning) del(r);
                      }}>
                      <td><span className="chip" style={{ background: r.project_color, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />{r.project_name}</td>
                      <td title={r.subtask_name ? `${r.task_name} ▸ ${r.subtask_name}` : r.task_name}>
                        {r.task_name}{r.subtask_name ? <span className="muted"> ▸ {r.subtask_name}</span> : ''}
                      </td>
                      <td>{fmtDateTime(r.started_at, tz)}</td>
                      <td>{isRunning ? <span className="muted">running…</span> : r.ended_at ? fmtClock(r.ended_at, tz) : ''}</td>
                      <td className="num">{isRunning ? <b style={{ color: 'var(--danger)' }}>+{mins}</b> : mins}m</td>
                      <td><span className={`badge ${r.source}`}>{r.source}</span></td>
                      <td className="muted" title={r.note || undefined} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</td>
                      <td>
                        <button className="btn ghost small" aria-label={`Edit session on ${r.task_name}`}
                          onClick={() => setEditing(r)}>✎</button>
                        <button className="btn ghost small" aria-label={`Delete session on ${r.task_name}`}
                          disabled={isRunning}
                          onClick={() => del(r)}>🗑</button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No sessions match these filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(1)} aria-label="First page">«</button>
          <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Page {page} of {totalPages} · {total} session{total === 1 ? '' : 's'}
          </span>
          <button className="btn small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          <button className="btn small" disabled={page >= totalPages} onClick={() => setPage(totalPages)} aria-label="Last page">»</button>
        </div>
      </div>

      {editing && (
        <SessionEditor
          initial={editing === 'new' ? null : editing}
          tz={tz}
          defaultTaskId={taskId || undefined}
          suggestEnd={editing === 'new' ? Date.now() : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); store.bumpReports(); }}
        />
      )}
    </div>
  );
}

/** "2h 05m"-style duration for the editor's timezone hint line. */
function fmtDur(mins: number): string {
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
}

/** Manual add/edit (FR-S4). Conflicts (same-task overlap) are listed inline. */
function SessionEditor({
  initial, tz, defaultTaskId, onClose, onSaved, suggestEnd
}: {
  initial: Partial<LogRow> | null;
  tz: string;
  defaultTaskId?: string;
  onClose: () => void;
  onSaved: () => void;
  suggestEnd?: number;
}) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const selectedTaskId = useStore((s) => s.selectedTaskId);

  const [taskId, setTaskId] = useState(initial?.task_id ?? defaultTaskId ?? selectedTaskId ?? tasks[0]?.id ?? '');
  const [taskText, setTaskText] = useState(
    initial?.task_id ? (tasks.find((t) => t.id === initial.task_id)?.name ?? '') : ''
  );
  const [subtaskId, setSubtaskId] = useState<string | null>(initial?.subtask_id ?? null);
  const [start, setStart] = useState(toLocalInput(initial?.started_at ?? Date.now() - 3600_000, tz));
  // manual sessions are closed intervals: open-ended rows collide with the
  // running-session unique index
  const [end, setEnd] = useState(initial?.ended_at
    ? toLocalInput(initial.ended_at, tz)
    : toLocalInput(suggestEnd ?? Date.now(), tz));
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<{ message: string; conflicts?: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalA11y(onClose);

  // render-time tz echo (typing can momentarily leave the fields empty → null-safe)
  const startInstant = parseLocalInput(start, tz);
  const endInstant = parseLocalInput(end, tz);
  const durationMin = startInstant !== null && endInstant !== null
    ? Math.round((endInstant - startInstant) / 60000)
    : 0;
  const tzWarning = localTimeWarning(start, tz) ?? localTimeWarning(end, tz);

  const isEdit = !!initial?.id;

  const filteredTasks = tasks; // picker is searchable below rather than pre-filtered

  // task picker groups: one per project (same coverage the old <datalist> had)
  const taskGroups = useMemo(() => (
    projects.map((p) => ({
      label: p.name,
      options: filteredTasks.filter((t) => t.project_id === p.id)
        .map((t) => ({ value: t.id, label: t.name, color: p.color }))
    })).filter((g) => g.options.length > 0)
  ), [projects, filteredTasks]);

  /** Resolve typed text → task id: exact (case-insensitive), then unique contains. */
  const resolveTask = (text: string): string | null => {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const exact = filteredTasks.find((x) => x.name.toLowerCase() === t);
    if (exact) return exact.id;
    const hits = filteredTasks.filter((x) => x.name.toLowerCase().includes(t));
    return hits.length === 1 ? hits[0]!.id : null;
  };

  async function save() {
    setError(null);
    // never save against a silently-stale task: typed text that matches
    // nothing is an error, not "keep the previous selection"
    let finalTaskId = taskId;
    if (taskText.trim().toLowerCase() !== (tasks.find((t) => t.id === taskId)?.name ?? '').toLowerCase()) {
      const resolved = resolveTask(taskText);
      if (!resolved) {
        setError({ message: 'Pick a task from the list — no exact or unique match for that name' });
        return;
      }
      finalTaskId = resolved;
    }
    if (!finalTaskId) {
      setError({ message: 'Pick a task from the list' });
      return;
    }
    const body = {
      task_id: finalTaskId,
      subtask_id: taskId === finalTaskId ? (subtaskId ?? null) : null, // task changed → link resets
      started_at: fromLocalInput(start, tz),
      ended_at: fromLocalInput(end, tz),
      note
    };
    try {
      setBusy(true);
      if (isEdit) await api(`/sessions/${initial!.id}`, { method: 'PATCH', body });
      else await api('/sessions', { method: 'POST', body });
      onSaved();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'overlap') {
        setError({ message: e.message, conflicts: (e.details as any[]) ?? [] });
      } else setError({ message: e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Session editor" onClick={onClose}>
      <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? 'Edit session' : 'Add manual session'}</h3>
        <label className="field">
          <span>Task</span>
          <Combobox
            ariaLabel="Task"
            text={taskText}
            onTextChange={(v) => {
              setTaskText(v);
              const hit = resolveTask(v);
              if (hit) setTaskId(hit);
            }}
            onPick={(id) => {
              setTaskId(id);
              setTaskText(tasks.find((t) => t.id === id)?.name ?? '');
              setSubtaskId(null); // the previous task's subtask never fits the new one
            }}
            groups={taskGroups}
            placeholder="Type to search…"
          />
        </label>
        <label className="field">
          <span>Subtask (optional — attributes this session's time to it)</span>
          <Dropdown
            ariaLabel="Subtask"
            value={subtaskId ?? ''}
            onChange={(v) => setSubtaskId(v === '' ? null : v)}
            options={[
              { value: '', label: `Whole task — ${tasks.find((t) => t.id === taskId)?.name ?? 'no subtask'}`, icon: '◂' },
              ...subtasks.filter((sb) => sb.task_id === taskId)
                .map((sb) => ({ value: sb.id, label: sb.name, icon: sb.done ? '☑' : '☐' }))
            ]} />
        </label>
        <div className="grid-2col">
          <label className="field">
            {/* both fields are wall-clock in the PROFILE timezone — the hint below
                makes that (and the resulting duration) visible before saving */}
            <span>Start ({tz})</span>
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>End ({tz})</span>
            <input className="input" type="datetime-local" value={end}
              onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '-6px 0 10px' }}>
          {startInstant !== null && `Times are in ${tz} (${fmtUtcOffset(startInstant, tz)} at the start)`}
          {startInstant !== null && endInstant !== null && (
            durationMin < 0 ? ' · end is before the start' : ` · duration ${fmtDur(durationMin)}`
          )}
        </p>
        {tzWarning && (
          <p className="muted" style={{ fontSize: 12, margin: '-4px 0 10px' }} role="status">⚠ {tzWarning}</p>
        )}
        <label className="field">
          <span>Note</span>
          <input className="input" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>

        {error && (
          <div className="error-text" role="alert">
            {error.message}
            {error.conflicts?.length ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {error.conflicts.map((c) => (
                  <li key={c.id}>{fmtDateTime(c.started_at, tz)} → {c.ended_at ? fmtClock(c.ended_at, tz) : 'running'}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : isEdit ? 'Save' : 'Add session'}</button>
        </div>
      </div>
    </div>
  );
}
