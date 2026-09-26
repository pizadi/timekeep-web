// Tree sidebar: projects → tasks → subtask checklists (FR-P, FR-T).
// Cheap editing (FR-T4): in-place rename (single click on selected row / F2),
// Delete-with-undo toast, no modal for renames; typed confirmation only for
// project deletion (FR-P1). Subtask toggling never touches the timer (FR-T2).
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { store, useStore, pushToast, undoableDelete } from '../lib/store';
import { api } from '../lib/api';
import { PALETTE, GROUP_PERMS, parseGroupPerms, type GroupPerm } from '../../shared/constants';
import { openPrompt } from '../components/PromptModal';
import { useModalA11y } from '../lib/modal';
import { useBreakpoint } from '../lib/responsive';
import HoverScrollText from '../components/HoverScrollText';
import {
  addProject,
  addTask,
  addSubtask,
  toggleTaskDone,
  toggleSubtaskDone,
  toggleTaskTimer,
  toggleSubtaskTimer,
  toggleLastTask,
} from '../lib/actions';
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
  // secondary row actions collapse into a ⋯ menu on every screen
  const [menu, setMenu] = useState<{ kind: 'project' | 'task'; id: string; x: number; y: number } | null>(null);

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

  // context-aware actions: N (new task), P (new project), S (new subtask),
  // T (toggle timer), R (stop timer / resume last task), F2 (rename), Delete (undo-able).
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
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
      const selTask = tasks.find((t) => t.id === selectedTaskId);
      if (e.key.toLowerCase() === 'n' && bare) {
        e.preventDefault();
        if (selectedProjectId) await addTask(selectedProjectId);
        else await addProject();
      } else if (e.key.toLowerCase() === 'p' && bare) {
        e.preventDefault();
        await addProject();
      } else if (e.key.toLowerCase() === 's' && bare && selTask) {
        e.preventDefault();
        await addSubtask(selTask.id);
      } else if (e.key.toLowerCase() === 't' && bare && selTask) {
        e.preventDefault();
        await toggleTaskTimer(selTask.id);
      } else if (e.key.toLowerCase() === 'r' && bare) {
        // stop when running; otherwise resume the most recently tracked task
        e.preventDefault();
        await toggleLastTask();
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

  async function rename(kind: 'project' | 'task' | 'subtask', id: string, name: string) {
    setRenaming(null);
    if (!name.trim()) return;
    try {
      const path = kind === 'project' ? `/projects/${id}` : kind === 'task' ? `/tasks/${id}` : `/subtasks/${id}`;
      const res = await api<any>(path, { method: 'PATCH', body: { name: name.trim() } });
      store.upsertLocal(kind, res[kind]);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  async function deleteTask(id: string) {
    try {
      const res = await api<{ undo: any }>(`/tasks/${id}`, { method: 'DELETE' });
      store.removeLocalTask(id);
      if (res.undo) undoableDelete(`Task deleted — undo?`, res.undo);
      else pushToast('info', 'Task deleted (shared with the group — no undo)');
    } catch (e: any) {
      pushToast('error', e.message);
    }
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
      mustType: p?.name ?? '',
    });
    if (typed === null || typed.trim() !== p?.name) {
      pushToast('info', 'Deletion cancelled');
      return;
    }
    try {
      const res = await api<{ undo: any }>(`/projects/${id}`, { method: 'DELETE' });
      store.removeLocalProject(id);
      if (res.undo) undoableDelete(`Project "${p?.name}" deleted — undo?`, res.undo);
      else pushToast('info', `Group project "${p?.name}" deleted for all members (no undo)`);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  async function setColor(id: string, color: string) {
    setColorFor(null);
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, { method: 'PATCH', body: { color } });
      store.upsertLocal('project', res.project);
      store.bumpReports();
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  /** Social visibility: 'private' (only you) ↔ 'friends' (visible to your friends). */
  async function setVisibility(id: string, shared: boolean) {
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, {
        method: 'PATCH',
        body: { visibility: shared ? 'friends' : 'private' },
      });
      store.upsertLocal('project', res.project);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  /** Optimistic archive — the row flips instantly, reverts on failure (the
   *  PATCH round trip made archiving feel multi-second on slow links). */
  async function setArchive(id: string, archived: boolean) {
    const prev = projects.find((p) => p.id === id);
    if (!prev) return;
    store.upsertLocal('project', { ...prev, archived: (archived ? 1 : 0) as 0 | 1 });
    try {
      const res = await api<{ project: any }>(`/projects/${id}`, { method: 'PATCH', body: { archived } });
      store.upsertLocal('project', res.project);
    } catch (e: any) {
      store.upsertLocal('project', prev);
      pushToast('error', e.message);
    }
  }

  async function moveProject(id: string, dir: -1 | 1) {
    const list = personal;
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    const ids = list.map((p) => p.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await api('/projects/reorder', { method: 'POST', body: { ids } });
      void store.refreshAll();
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  function rowProps(kind: 'project' | 'task', id: string, selected: boolean, onClick: () => void) {
    return {
      onClick: () => {
        onClick();
        // Keep the drawer open when a project is selected so its lower-pane
        // details are visible on phones; task selection still dismisses it.
        if (kind === 'task') onClose?.();
        // in-place rename: single click on an already-selected row (FR-T4)
        if (selected && renaming?.id !== id) setRenaming({ kind, id });
      },
      onDoubleClick: () => setRenaming({ kind, id }),
      tabIndex: 0,
      role: 'treeitem',
      'aria-selected': selected,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') onClick();
        if (e.key === 'F2') {
          e.preventDefault();
          setRenaming({ kind, id });
        }
      },
    };
  }

  /** Anchor the ⋯ action menu just below its button (viewport-clamped in RowMenu). */
  function openMenu(kind: 'project' | 'task', id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ kind, id, x: r.left, y: r.bottom + 4 });
  }

  /** One project (personal or group) with permission-gated controls. */
  function projectRow(p: Project) {
    return (
      <>
        <div
          {...rowProps('project', p.id, selectedProjectId === p.id, () => store.selectProject(p.id))}
          className={`row ${selectedProjectId === p.id ? 'selected' : ''}`}
        >
          <span className="chip" style={{ background: p.color }} aria-hidden />
          {renaming?.kind === 'project' && renaming.id === p.id ? (
            <RenameInput
              initial={p.name}
              onCommit={(v) => rename('project', p.id, v)}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <HoverScrollText className="grow" title={p.name}>
              {p.name}
            </HoverScrollText>
          )}
          <button
            className="icon-btn"
            aria-label={`More actions for ${p.name}`}
            title="More actions"
            onClick={(e) => openMenu('project', p.id, e)}
          >
            ⋯
          </button>
        </div>

        {colorFor === p.id && (
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 10px 8px' }}
            role="menu"
            aria-label="Project colors"
          >
            {PALETTE.map((c) => (
              <button
                key={c}
                aria-label={`Use color ${c}`}
                className="chip"
                style={{ background: c, width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)' }}
                onClick={() => setColor(p.id, c)}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  function taskDetails(p: Project) {
    const perms = permsFor(p);
    const canEditTasks = !p.group_id || (perms?.includes('edit_tasks') ?? false);
    const projectTasks = tasks.filter((t) => t.project_id === p.id);
    return (
      <>
        <div className="tree-selected-heading">
          <strong className="grow" title={p.name}>
            {p.name}
          </strong>
          <span className="muted">
            {projectTasks.length} {projectTasks.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
        {projectTasks.length === 0 ? (
          <div className="muted" style={{ padding: '2px 8px 8px 20px' }}>
            No tasks yet.
          </div>
        ) : (
          projectTasks.map((t) => {
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
                  <input
                    type="checkbox"
                    checked={!!t.done}
                    aria-label={`Done: ${t.name}`}
                    disabled={!canEditTasks}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleTaskDone(t)}
                  />
                  {renaming?.kind === 'task' && renaming.id === t.id ? (
                    <RenameInput
                      initial={t.name}
                      onCommit={(v) => rename('task', t.id, v)}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <HoverScrollText className={`grow ${t.done ? 'done-text' : ''}`} title={t.name}>
                      {t.name}
                    </HoverScrollText>
                  )}
                  {pct !== null && (
                    <span className="sub" aria-label={`${pct}% of subtasks done`}>
                      {pct}%
                    </span>
                  )}
                  <button
                    className="icon-btn"
                    aria-label={`Start timer on ${t.name}`}
                    title="Timer (T)"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTaskTimer(t.id);
                    }}
                  >
                    {isRunning ? '■' : '▶'}
                  </button>
                  {canEditTasks && (
                    <button
                      className="icon-btn"
                      aria-label={`More actions for ${t.name}`}
                      title="More actions"
                      onClick={(e) => openMenu('task', t.id, e)}
                    >
                      ⋯
                    </button>
                  )}
                </div>
                {sbs.map((sb) => (
                  <div key={sb.id} className="row" style={{ paddingLeft: 38, minHeight: 26 }}>
                    <input
                      type="checkbox"
                      checked={!!sb.done}
                      aria-label={`Done: ${sb.name}`}
                      disabled={!canEditTasks}
                      onChange={() => void toggleSubtaskDone(sb)}
                    />
                    {renaming?.kind === 'subtask' && renaming.id === sb.id ? (
                      <RenameInput
                        initial={sb.name}
                        onCommit={(v) => rename('subtask', sb.id, v)}
                        onCancel={() => setRenaming(null)}
                      />
                    ) : (
                      <HoverScrollText className={`grow ${sb.done ? 'done-text' : ''}`} title={sb.name}>
                        <span
                          onDoubleClick={() => canEditTasks && setRenaming({ kind: 'subtask', id: sb.id })}
                          onKeyDown={(e) => {
                            if (e.key === 'F2' && canEditTasks) setRenaming({ kind: 'subtask', id: sb.id });
                          }}
                          tabIndex={0}
                          role="treeitem"
                          aria-selected={false}
                        >
                          {sb.name}
                        </span>
                      </HoverScrollText>
                    )}
                    {canEditTasks && (
                      <button
                        className="icon-btn"
                        aria-label={`Delete subtask ${sb.name}`}
                        onClick={async () => {
                          try {
                            const res = await api<{ undo: any }>(`/subtasks/${sb.id}`, { method: 'DELETE' });
                            store.removeLocalSubtask(sb.id);
                            if (res.undo) undoableDelete('Subtask deleted — undo?', res.undo);
                          } catch (e: any) {
                            pushToast('error', e.message);
                          }
                        }}
                      >
                        ✕
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      aria-label={`Track subtask ${sb.name}`}
                      title="Track this subtask"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSubtaskTimer(t.id, sb.id);
                      }}
                    >
                      {running?.subtask_id === sb.id ? '■' : '▶'}
                    </button>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </>
    );
  }

  return (
    <div className="tree" role="tree" aria-label="Projects and tasks">
      <div className="tree-project-list">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 8px 8px' }}>
          <button className="btn small primary" onClick={addProject}>
            ＋ Project{' '}
            <span className="kbd" style={{ marginLeft: 4 }}>
              P
            </span>
          </button>
          <button
            className="btn small"
            disabled={!selectedProjectId || !canAddTask}
            title={
              selectedProjectId && !canAddTask
                ? "You don't have the edit_tasks permission in this group"
                : 'New task (context-aware)'
            }
            onClick={() => selectedProjectId && addTask(selectedProjectId)}
          >
            ＋ Task{' '}
            <span className="kbd" style={{ marginLeft: 4 }}>
              N
            </span>
          </button>
          <button
            className="btn small"
            title={running ? 'Stop the running timer' : 'Resume tracking on the last tracked task'}
            onClick={() => void toggleLastTask()}
          >
            {running ? '■ Stop' : '▶ Resume'}{' '}
            <span className="kbd" style={{ marginLeft: 4 }}>
              R
            </span>
          </button>
        </div>

        {personal.length === 0 && groupProjects.size === 0 && (
          <div className="muted" style={{ padding: '8px 10px' }}>
            No projects yet — create one above.
          </div>
        )}

        {personal.map((p) => (
          <div key={p.id} className="tree-project">
            {projectRow(p)}
          </div>
        ))}

        {[...groupProjects.entries()].map(([groupId, gProjects]) => {
          const g = groups.find((x) => x.id === groupId);
          return (
            <div key={groupId}>
              <div className="tree-section-title" title="Group project — visible to current members only">
                👥 {g?.name ?? 'Group'} ({gProjects.length})
              </div>
              {gProjects.map((p) => (
                <div key={p.id} className="tree-project">
                  {projectRow(p)}
                </div>
              ))}
            </div>
          );
        })}

        {archived.length > 0 && (
          <>
            <div
              className="tree-section-title"
              role="button"
              aria-expanded={archiveOpen}
              onClick={() => setArchiveOpen((v) => !v)}
              style={{ cursor: 'pointer' }}
            >
              Archived ({archived.length}) {archiveOpen ? '▾' : '▸'}
            </div>
            {archiveOpen &&
              archived.map((p) => (
                <div key={p.id} className="row">
                  <span className="chip" style={{ background: p.color }} />
                  <HoverScrollText className="grow done-text" title={p.name}>
                    {p.name}
                  </HoverScrollText>
                  <button
                    className="icon-btn"
                    aria-label={`Restore ${p.name}`}
                    title="Restore"
                    onClick={() => setArchive(p.id, false)}
                  >
                    ↩
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete archived ${p.name}`}
                    onClick={() => deleteProject(p.id)}
                  >
                    🗑
                  </button>
                </div>
              ))}
          </>
        )}
      </div>

      <div className="tree-selected-details" aria-label="Selected project tasks">
        {selProject && !selProject.archived ? (
          taskDetails(selProject)
        ) : (
          <div className="muted" style={{ padding: '10px 8px' }}>
            Select a project to see its tasks.
          </div>
        )}
      </div>

      {menu && menuFor(menu)}
    </div>
  );

  /** Resolves the open ⋯ menu to its row's action list. */
  function menuFor(m: NonNullable<typeof menu>) {
    const close = () => setMenu(null);
    if (m.kind === 'project') {
      const p = projects.find((x) => x.id === m.id);
      if (!p) return null;
      const isGroup = !!p.group_id;
      const perms = permsFor(p);
      const canManage = !isGroup || (perms?.includes('manage_projects') ?? false);
      return (
        <RowMenu x={m.x} y={m.y} label={`Actions for ${p.name}`} onClose={close}>
          <button
            className="btn small"
            onClick={() => {
              close();
              setRenaming({ kind: 'project', id: p.id });
            }}
          >
            ✎ Rename
          </button>
          {canManage && (
            <button
              className="btn small"
              onClick={() => {
                close();
                setColorFor(colorFor === p.id ? null : p.id);
              }}
            >
              ◐ Color…
            </button>
          )}
          {!isGroup && (
            <>
              <button
                className="btn small"
                onClick={() => {
                  close();
                  moveProject(p.id, -1);
                }}
              >
                ↑ Move up
              </button>
              <button
                className="btn small"
                onClick={() => {
                  close();
                  moveProject(p.id, 1);
                }}
              >
                ↓ Move down
              </button>
              <button
                className="btn small"
                onClick={() => {
                  close();
                  setVisibility(p.id, p.visibility !== 'friends');
                }}
              >
                {p.visibility === 'friends' ? '🔒 Make private' : '👀 Share with friends'}
              </button>
            </>
          )}
          {canManage && (
            <>
              <button
                className="btn small"
                onClick={() => {
                  close();
                  setArchive(p.id, true);
                }}
              >
                📦 Archive
              </button>
              <button
                className="btn small danger"
                onClick={() => {
                  close();
                  void deleteProject(p.id);
                }}
              >
                🗑 Delete project
              </button>
            </>
          )}
        </RowMenu>
      );
    }
    const t = tasks.find((x) => x.id === m.id);
    if (!t) return null;
    return (
      <RowMenu x={m.x} y={m.y} label={`Actions for ${t.name}`} onClose={close}>
        <button
          className="btn small"
          onClick={() => {
            close();
            setRenaming({ kind: 'task', id: t.id });
          }}
        >
          ✎ Rename
        </button>
        <button
          className="btn small"
          onClick={() => {
            close();
            void addSubtask(t.id);
          }}
        >
          ＋ Add subtask
        </button>
        <button
          className="btn small danger"
          onClick={() => {
            close();
            void deleteTask(t.id);
          }}
        >
          🗑 Delete task
        </button>
      </RowMenu>
    );
  }
}

/** Action menu for a sidebar row: anchored popover on desktop, bottom sheet
 *  on phones (positioning handled by .row-menu CSS). */
function RowMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const phone = useBreakpoint() === 'phone';
  const ref = useModalA11y(onClose);
  const style: CSSProperties | undefined = phone
    ? undefined
    : {
        left: Math.min(Math.max(8, x), window.innerWidth - 268),
        top: Math.min(Math.max(8, y), window.innerHeight - 240),
      };
  return createPortal(
    <div
      className="modal-overlay row-menu-overlay"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="modal row-menu"
        style={style}
        role="menu"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
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
        if (e.key === 'Escape') {
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onCommit(v);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
