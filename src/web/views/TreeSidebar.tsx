// Tree sidebar: projects → tasks → subtask checklists (FR-P, FR-T).
// Cheap editing (FR-T4): in-place rename (single click on selected row / F2),
// Delete-with-undo toast, no modal for renames; typed confirmation only for
// project deletion (FR-P1). Subtask toggling never touches the timer (FR-T2).
import { useEffect, useRef, useState } from 'react';
import { store, useStore, pushToast, undoableDelete } from '../lib/store';
import { api, ApiError } from '../lib/api';
import { PALETTE } from '../../shared/constants';
import { openPrompt } from '../components/PromptModal';
import { parseGroupPerms } from './GroupsPanel';
import { GROUP_PERMS, type GroupPerm } from '../../shared/constants';
import type { Project } from '../lib/store';

const ALL_PERMS: GroupPerm[] = [...GROUP_PERMS];

export default function TreeSidebar({ onClose }: { onClose?: () => void }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const groups = useStore((s) => s.groups);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const running = useStore((s) => s.running);

  const [renaming, setRenaming] = useState<{ kind: 'project' | 'task' | 'subtask'; id: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [colorFor, setColorFor] = useState<string | null>(null);

  const personal = projects.filter((p) => !p.archived && !p.group_id);
  const archived = projects.filter((p) => !!p.archived && !p.group_id);
  const groupProjects = new Map<string, typeof projects>();
  for (const p of projects) {
    if (!p.group_id) continue;
    const list = groupProjects.get(p.group_id) ?? [];
    list.push(p);
    groupProjects.set(p.group_id, list);
  }
  /** My perms inside the group that owns this project (null = personal). */
  function permsFor(p: Project): GroupPerm[] | null {
    if (!p.group_id) return null;
    const g = groups.find((x) => x.id === p.group_id);
    if (!g) return null;
    return g.role === 'owner' ? ALL_PERMS : parseGroupPerms(g.perms);
  }
  const selProject = projects.find((p) => p.id === selectedProjectId);
  const selPerms = selProject ? permsFor(selProject) : null;
  const canAddTask = !!selProject && (!selProject.group_id || (selPerms?.includes('edit_tasks') ?? false));

  // context-aware actions: N (new task), T (toggle timer), F2 (rename), Delete (undo-able).
  // Suppressed while a modal is open (audit: shortcuts fired through modals).
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) {
        if (e.key === 'Escape') setRenaming(null);
        return;
      }
      const modalOpen = document.querySelector('.modal-overlay, .qf-overlay');
      if (modalOpen) return;
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
  }  async function addSubtask(taskId: string) {
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
      await store.startTimer(taskId); // applies setRunning + setPomo (one shared impl)
    } catch (e: any) { pushToast('error', e.message); }
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
      if (res.undo) undoableDelete(`Task deleted — undo?`, res.undo);
      else pushToast('info', 'Task deleted (shared with the group — no undo)');
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function deleteProject(id: string) {
    const p = projects.find((x) => x.id === id);
    const isGroup = !!p?.group_id;
    const typed = await openPrompt({
      title: `Delete “${p?.name}”?`,
      message: isGroup
        ? 'This deletes the group project for EVERY member — tasks, checklists, dependencies and all tracked time go with it. This cannot be undone.'
        : 'This removes its tasks, checklists, dependencies and sessions. Undo is available for 5 seconds after deletion.',
      placeholder: p?.name ?? '',
      confirmText: 'Delete',
      danger: true,
      mustType: p?.name ?? ''
    });
    if (typed === null || typed.trim() !== p?.name) { pushToast('info', 'Deletion cancelled'); return; }
    try {
      const res = await api<{ undo: any }>(`/projects/${id}`, { method: 'DELETE' });
      store.removeLocalProject(id);
      if (res.undo) undoableDelete(`Project "${p?.name}" deleted — undo?`, res.undo);
      else pushToast('info', `Group project "${p?.name}" deleted for all members (no undo)`);
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

  /** Social visibility: 'private' (only you) ↔ 'friends' (visible to your friends). */
  async function setVisibility(id: string, shared: boolean) {
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, { method: 'PATCH', body: { visibility: shared ? 'friends' : 'private' } });
      store.upsertLocal('project', res.project);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function moveProject(id: string, dir: -1 | 1) {
    const list = personal;
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

  /** One project (personal or group) with permission-gated controls. */
  function projectRow(p: Project) {
    const perms = permsFor(p);           // null = personal (full control)
    const isGroup = !!p.group_id;
    const canEditTasks = !isGroup || (perms?.includes('edit_tasks') ?? false);
    const canManage = !isGroup || (perms?.includes('manage_projects') ?? false);
    return (
      <>
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
          {canManage && (
            <button className="icon-btn" aria-label={`Color for ${p.name}`} title="Color"
              onClick={(e) => { e.stopPropagation(); setColorFor(colorFor === p.id ? null : p.id); }}>◐</button>
          )}
          {!isGroup && (
            <>
              <button className="icon-btn" aria-label={`Move ${p.name} up`} title="Move up"
                onClick={(e) => { e.stopPropagation(); moveProject(p.id, -1); }}>↑</button>
              <button className="icon-btn" aria-label={`Move ${p.name} down`} title="Move down"
                onClick={(e) => { e.stopPropagation(); moveProject(p.id, 1); }}>↓</button>
              <button className="icon-btn" aria-label={`Visibility for ${p.name}: ${p.visibility === 'friends' ? 'friends' : 'private'}`}
                title={p.visibility === 'friends' ? 'Visible to friends — click to make private' : 'Private — click to share with friends'}
                onClick={(e) => { e.stopPropagation(); setVisibility(p.id, p.visibility !== 'friends'); }}>
                {p.visibility === 'friends' ? '👀' : '🔒'}
              </button>
            </>
          )}
          {canManage && (
            <>
              <button className="icon-btn" aria-label={`Archive ${p.name}`} title="Archive"
                onClick={(e) => { e.stopPropagation(); setArchive(p.id, true); }}>📦</button>
              <button className="icon-btn" aria-label={`Delete ${p.name}`} title="Delete (typed confirmation)"
                onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}>🗑</button>
            </>
          )}
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
                  disabled={!canEditTasks}
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
                {canEditTasks && (
                  <>
                    <button className="icon-btn" aria-label={`Add subtask to ${t.name}`} title="Add subtask"
                      onClick={(e) => { e.stopPropagation(); addSubtask(t.id); }}>＋</button>
                    <button className="icon-btn" aria-label={`Delete ${t.name}`} title="Delete (undo for 5s)"
                      onClick={(e) => { e.stopPropagation(); deleteTask(t.id); }}>🗑</button>
                  </>
                )}
              </div>
              {sbs.map((sb) => (
                <div key={sb.id} className="row" style={{ paddingLeft: 38, minHeight: 26 }}>
                  <input type="checkbox" checked={!!sb.done} aria-label={`Done: ${sb.name}`} disabled={!canEditTasks}
                    onChange={() => toggleSubtask(sb)} />
                  {renaming?.kind === 'subtask' && renaming.id === sb.id ? (
                    <RenameInput initial={sb.name} onCommit={(v) => rename('subtask', sb.id, v)} onCancel={() => setRenaming(null)} />
                  ) : (
                    <span className={`grow ${sb.done ? 'done-text' : ''}`}
                      onDoubleClick={() => canEditTasks && setRenaming({ kind: 'subtask', id: sb.id })}
                      onKeyDown={(e) => { if (e.key === 'F2' && canEditTasks) setRenaming({ kind: 'subtask', id: sb.id }); }}
                      tabIndex={0} role="treeitem" aria-selected={false}>{sb.name}</span>
                  )}
                  {canEditTasks && (
                    <button className="icon-btn" aria-label={`Delete subtask ${sb.name}`}
                      onClick={async () => {
                        try {
                          const res = await api<{ undo: any }>(`/subtasks/${sb.id}`, { method: 'DELETE' });
                          store.removeLocalSubtask(sb.id);
                          if (res.undo) undoableDelete('Subtask deleted — undo?', res.undo);
                        } catch (e: any) { pushToast('error', e.message); }
                      }}>✕</button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div className="tree" role="tree" aria-label="Projects">
      <div style={{ display: 'flex', gap: 6, padding: '2px 8px 8px' }}>
        <button className="btn small primary" onClick={addProject}>＋ Project</button>
        <button className="btn small" disabled={!selectedProjectId || !canAddTask}
          title={selectedProjectId && !canAddTask ? "You don't have the edit_tasks permission in this group" : undefined}
          onClick={() => selectedProjectId && addTask(selectedProjectId)}>＋ Task <span className="kbd" style={{ marginLeft: 4 }}>N</span></button>
      </div>

      {personal.length === 0 && groupProjects.size === 0 && <div className="muted" style={{ padding: '8px 10px' }}>No projects yet — create one above.</div>}

      {personal.map((p) => (
        <div key={p.id} className="tree-project">{projectRow(p)}</div>
      ))}

      {[...groupProjects.entries()].map(([groupId, gProjects]) => {
        const g = groups.find((x) => x.id === groupId);
        return (
          <div key={groupId}>
            <div className="tree-section-title" title="Group project — visible to current members only">
              👥 {g?.name ?? 'Group'} ({gProjects.length})
            </div>
            {gProjects.map((p) => (
              <div key={p.id} className="tree-project">{projectRow(p)}</div>
            ))}
          </div>
        );
      })}

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
