// Tree sidebar: projects → tasks → subtask checklists (FR-P, FR-T).
// Cheap editing (FR-T4): in-place rename (single click on selected row / F2),
// Delete-with-undo toast, no modal for renames; typed confirmation only for
// project deletion (FR-P1). Subtask toggling never touches the timer (FR-T2).
import { useEffect, useRef, useState } from 'react';
import { store, useStore, pushToast, undoableDelete } from '../lib/store';
import { api, ApiError } from '../lib/api';
import { PALETTE } from '../../shared/constants';
import { openPrompt } from '../components/PromptModal';

export default function TreeSidebar({ onClose }: { onClose?: () => void }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const running = useStore((s) => s.running);

  const [renaming, setRenaming] = useState<{ kind: 'project' | 'task' | 'subtask'; id: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [colorFor, setColorFor] = useState<string | null>(null);

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => !!p.archived);

  // context-aware actions: N (new task), T (toggle timer), F2 (rename), Delete (undo-able)
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) {
        if (e.key === 'Escape') setRenaming(null);
        return;
      }
      const selTask = tasks.find((t) => t.id === selectedTaskId);
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (selectedProjectId) await addTask(selectedProjectId);
        else await addProject();
      } else if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && selTask) {
        e.preventDefault();
        await toggleTimer(selTask.id);
      } else if (e.key === 'F2') {
        e.preventDefault();
        if (selTask) setRenaming({ kind: 'task', id: selTask.id });
      } else if (e.key === 'Delete' && selTask && !running?.task_id) {
        e.preventDefault();
        await deleteTask(selTask.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tasks, selectedTaskId, selectedProjectId, running]);

  async function addProject() {
    // non-blocking modal instead of window.prompt
    const name = await openPrompt({ title: 'New project', placeholder: 'Project name', confirmText: 'Create' });
    if (!name?.trim()) return;
    try {
      const res = await api<{ project: any }>('/projects', { method: 'POST', body: { name: name.trim() } });
      store.upsertLocal('project', res.project);
      store.selectProject(res.project.id);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function addTask(projectId: string) {
    const name = await openPrompt({ title: 'New task', placeholder: 'Task name', confirmText: 'Create' });
    if (!name?.trim()) return;
    try {
      const res = await api<{ task: any }>(`/projects/${projectId}/tasks`, { method: 'POST', body: { name: name.trim() } });
      store.upsertLocal('task', res.task);
      store.selectTask(res.task.id);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function addSubtask(taskId: string) {
    const name = await openPrompt({ title: 'New subtask', placeholder: 'Subtask name', confirmText: 'Create' });
    if (!name?.trim()) return;
    try {
      const res = await api<{ subtask: any }>(`/tasks/${taskId}/subtasks`, { method: 'POST', body: { name: name.trim() } });
      store.upsertLocal('subtask', res.subtask);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function rename(kind: 'project' | 'task' | 'subtask', id: string, name: string) {
    setRenaming(null);
    if (!name.trim()) return;
    try {
      const path = kind === 'project' ? `/projects/${id}` : kind === 'task' ? `/tasks/${id}` : `/subtasks/${id}`;
      const res = await api<any>(path, { method: 'PATCH', body: { name: name.trim() } });
      store.upsertLocal(kind, res[kind]);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function toggleTimer(taskId: string) {
    if (running?.task_id === taskId) {
      try { await api('/timer/stop', { method: 'POST' }); store.setRunning(null); }
      catch (e: any) { pushToast('error', e.message); }
      return;
    }
    try {
      const res = await api<{ session: any; pomo?: any }>('/timer/start', { method: 'POST', body: { task_id: taskId } });
      store.setRunning(res.session);
      if (res.pomo) store.setPomo(res.pomo);
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'already_running') {
        try {
          const res = await api<{ started: any; pomo?: any }>('/timer/switch', { method: 'POST', body: { task_id: taskId } });
          store.setRunning(res.started);
          if (res.pomo) store.setPomo(res.pomo);
        } catch (e2: any) { pushToast('error', e2.message); }
      } else pushToast('error', e.message);
    }
  }

  async function toggleTaskDone(task: any) {
    try {
      const res = await api<{ task: any }>(`/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
      store.upsertLocal('task', res.task);
      store.bumpReports();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function toggleSubtask(sb: any) {
    // immediate visual feedback; rapid taps each persist (FR-M9 AC parity in tree)
    store.upsertLocal('subtask', { ...sb, done: sb.done ? 0 : 1 });
    try {
      const res = await api<{ subtask: any }>(`/subtasks/${sb.id}`, { method: 'PATCH', body: { done: !sb.done } });
      store.upsertLocal('subtask', res.subtask);
    } catch (e: any) { pushToast('error', e.message); void store.refreshAll(); }
  }

  async function deleteTask(id: string) {
    try {
      const res = await api<{ undo: any }>(`/tasks/${id}`, { method: 'DELETE' });
      store.removeLocalTask(id);
      undoableDelete(`Task deleted — undo?`, res.undo);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function deleteProject(id: string) {
    const p = projects.find((x) => x.id === id);
    const typed = await openPrompt({
      title: `Delete “${p?.name}”?`,
      message: 'This removes its tasks, checklists, dependencies and sessions. Undo is available for 5 seconds after deletion.',
      placeholder: p?.name ?? '',
      confirmText: 'Delete',
      danger: true,
      mustType: p?.name ?? ''
    });
    if (typed === null || typed.trim() !== p?.name) { pushToast('info', 'Deletion cancelled'); return; }
    try {
      const res = await api<{ undo: any }>(`/projects/${id}`, { method: 'DELETE' });
      store.removeLocalProject(id);
      undoableDelete(`Project "${p?.name}" deleted — undo?`, res.undo);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function setArchive(id: string, archived: boolean) {
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, { method: 'PATCH', body: { archived } });
      store.upsertLocal('project', res.project);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function setColor(id: string, color: string) {
    setColorFor(null);
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, { method: 'PATCH', body: { color } });
      store.upsertLocal('project', res.project);
      store.bumpReports();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function moveProject(id: string, dir: -1 | 1) {
    const list = active;
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    const ids = list.map((p) => p.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try { await api('/projects/reorder', { method: 'POST', body: { ids } }); void store.refreshAll(); }
    catch (e: any) { pushToast('error', e.message); }
  }

  function rowProps(kind: 'project' | 'task', id: string, selected: boolean, onClick: () => void) {
    return {
      onClick: () => {
        onClick();
        onClose?.();
        // in-place rename: single click on an already-selected row (FR-T4)
        if (selected && renaming?.id !== id) setRenaming({ kind, id });
      },
      onDoubleClick: () => setRenaming({ kind, id }),
      tabIndex: 0,
      role: 'treeitem',
      'aria-selected': selected,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onClick();
        if (e.key === 'F2') { e.preventDefault(); setRenaming({ kind, id }); }
      }
    };
  }

  return (
    <div className="tree" role="tree" aria-label="Projects">
      <div style={{ display: 'flex', gap: 6, padding: '2px 8px 8px' }}>
        <button className="btn small primary" onClick={addProject}>＋ Project</button>
        <button className="btn small" disabled={!selectedProjectId}
          onClick={() => selectedProjectId && addTask(selectedProjectId)}>＋ Task <span className="kbd" style={{ marginLeft: 4 }}>N</span></button>
      </div>

      {active.length === 0 && <div className="muted" style={{ padding: '8px 10px' }}>No projects yet — create one above.</div>}

      {active.map((p) => (
        <div key={p.id} className="tree-project">
          <div
            {...rowProps('project', p.id, selectedProjectId === p.id, () => store.selectProject(p.id))}
            className={`row ${selectedProjectId === p.id ? 'selected' : ''}`}
          >
            <span className="chip" style={{ background: p.color }} aria-hidden />
            {renaming?.kind === 'project' && renaming.id === p.id ? (
              <RenameInput initial={p.name} onCommit={(v) => rename('project', p.id, v)} onCancel={() => setRenaming(null)} />
            ) : (
              <span className="grow" title={p.name}>{p.name}</span>
            )}
            <button className="icon-btn" aria-label={`Color for ${p.name}`} title="Color"
              onClick={(e) => { e.stopPropagation(); setColorFor(colorFor === p.id ? null : p.id); }}>◐</button>
            <button className="icon-btn" aria-label={`Move ${p.name} up`} title="Move up"
              onClick={(e) => { e.stopPropagation(); moveProject(p.id, -1); }}>↑</button>
            <button className="icon-btn" aria-label={`Move ${p.name} down`} title="Move down"
              onClick={(e) => { e.stopPropagation(); moveProject(p.id, 1); }}>↓</button>
            <button className="icon-btn" aria-label={`Archive ${p.name}`} title="Archive"
              onClick={(e) => { e.stopPropagation(); setArchive(p.id, true); }}>📦</button>
            <button className="icon-btn" aria-label={`Delete ${p.name}`} title="Delete (typed confirmation)"
              onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}>🗑</button>
          </div>

          {colorFor === p.id && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 10px 8px' }} role="menu" aria-label="Project colors">
              {PALETTE.map((c) => (
                <button key={c} aria-label={`Use color ${c}`} className="chip" style={{ background: c, width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)' }}
                  onClick={() => setColor(p.id, c)} />
              ))}
            </div>
          )}

          {selectedProjectId === p.id && tasks.filter((t) => t.project_id === p.id).map((t) => {
            const sbs = subtasks.filter((s) => s.task_id === t.id);
            const doneCount = sbs.filter((s) => !!s.done).length;
            const pct = sbs.length ? Math.round((doneCount / sbs.length) * 100) : null;
            const isRunning = running?.task_id === t.id;
            return (
              <div key={t.id}>
                <div
                  {...rowProps('task', t.id, selectedTaskId === t.id, () => store.selectTask(t.id))}
                  className={`row ${selectedTaskId === t.id ? 'selected' : ''}`}
                  style={{ paddingLeft: 20 }}
                >
                  {isRunning && <span className="dot-running" aria-label="tracking" />}
                  <input type="checkbox" checked={!!t.done} aria-label={`Done: ${t.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleTaskDone(t)} />
                  {renaming?.kind === 'task' && renaming.id === t.id ? (
                    <RenameInput initial={t.name} onCommit={(v) => rename('task', t.id, v)} onCancel={() => setRenaming(null)} />
                  ) : (
                    <span className={`grow ${t.done ? 'done-text' : ''}`} title={t.name}>{t.name}</span>
                  )}
                  {pct !== null && <span className="sub" aria-label={`${pct}% of subtasks done`}>{pct}%</span>}
                  <button className="icon-btn" aria-label={`Start timer on ${t.name}`} title="Timer (T)"
                    onClick={(e) => { e.stopPropagation(); toggleTimer(t.id); }}>{isRunning ? '■' : '▶'}</button>
                  <button className="icon-btn" aria-label={`Add subtask to ${t.name}`} title="Add subtask"
                    onClick={(e) => { e.stopPropagation(); addSubtask(t.id); }}>＋</button>
                  <button className="icon-btn" aria-label={`Delete ${t.name}`} title="Delete (undo for 5s)"
                    onClick={(e) => { e.stopPropagation(); deleteTask(t.id); }}>🗑</button>
                </div>
                {sbs.map((sb) => (
                  <div key={sb.id} className="row" style={{ paddingLeft: 38, minHeight: 26 }}>
                    <input type="checkbox" checked={!!sb.done} aria-label={`Done: ${sb.name}`}
                      onChange={() => toggleSubtask(sb)} />
                    {renaming?.kind === 'subtask' && renaming.id === sb.id ? (
                      <RenameInput initial={sb.name} onCommit={(v) => rename('subtask', sb.id, v)} onCancel={() => setRenaming(null)} />
                    ) : (
                      <span className={`grow ${sb.done ? 'done-text' : ''}`}
                        onDoubleClick={() => setRenaming({ kind: 'subtask', id: sb.id })}
                        onKeyDown={(e) => { if (e.key === 'F2') setRenaming({ kind: 'subtask', id: sb.id }); }}
                        tabIndex={0} role="treeitem" aria-selected={false}>{sb.name}</span>
                    )}
                    <button className="icon-btn" aria-label={`Delete subtask ${sb.name}`}
                      onClick={async () => {
                        try {
                          const res = await api<{ undo: any }>(`/subtasks/${sb.id}`, { method: 'DELETE' });
                          store.removeLocalSubtask(sb.id);
                          undoableDelete('Subtask deleted — undo?', res.undo);
                        } catch (e: any) { pushToast('error', e.message); }
                      }}>✕</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}

      {archived.length > 0 && (
        <>
          <div className="tree-section-title" role="button" aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((v) => !v)} style={{ cursor: 'pointer' }}>
            Archived ({archived.length}) {archiveOpen ? '▾' : '▸'}
          </div>
          {archiveOpen && archived.map((p) => (
            <div key={p.id} className="row">
              <span className="chip" style={{ background: p.color }} />
              <span className="grow done-text">{p.name}</span>
              <button className="icon-btn" aria-label={`Restore ${p.name}`} title="Restore"
                onClick={() => setArchive(p.id, false)}>↩</button>
              <button className="icon-btn" aria-label={`Delete archived ${p.name}`}
                onClick={() => deleteProject(p.id)}>🗑</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function RenameInput({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={v}
      aria-label="Rename"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(v);
        // Escape cancels — blur alone would commit via onBlur
        if (e.key === 'Escape') { cancelled.current = true; onCancel(); }
      }}
      onBlur={() => { if (!cancelled.current) onCommit(v); }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
