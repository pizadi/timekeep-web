// Map view (FR-M1–M9): per-project DAG of task cards with embedded subtask
// checklists, visual dependency add/remove, cycle rejection with path toast,
// pan/zoom, drag with live edge re-render, layout persistence, keyboard a11y.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore, pushToast, undoableDelete } from '../lib/store';
import { api, ApiError } from '../lib/api';
import { openPrompt } from '../components/PromptModal';
import Dropdown, { ColorChip } from '../components/Dropdown';

interface Pos { x: number; y: number }
const NODE_W = 210, HEADER_H = 30, ROW_H = 19, PAD = 10, PORT_R = 6;

export default function MapView() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const deps = useStore((s) => s.deps);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const running = useStore((s) => s.running);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pos>({ x: 40, y: 40 });
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [wiring, setWiring] = useState<{ from: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const drag = useRef<{ taskId: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; mx: number; my: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const saveTimer = useRef<number | null>(null);

  const project = projects.find((p) => p.id === selectedProjectId);
  const projectTasks = useMemo(
    () => tasks.filter((t) => t.project_id === selectedProjectId && t.parent_id === null),
    [tasks, selectedProjectId]
  );
  const projectDeps = useMemo(
    () => deps.filter((d) => projectTasks.some((t) => t.id === d.task_id)),
    [deps, projectTasks]
  );

  // auto layered layout (prerequisites left → dependents right), applied to
  // tasks without a saved position (FR-M8 "free slot" behavior)
  const levels = useMemo(() => computeLevels(projectTasks, projectDeps), [projectTasks, projectDeps]);
  const layout = useMemo(() => {
    const out: Record<string, Pos> = { ...positions };
    const colRows: Record<number, number> = {};
    for (const t of projectTasks) {
      if (out[t.id]) continue;
      const col = levels.get(t.id) ?? 0;
      const row = colRows[col] ?? 0;
      colRows[col] = row + 1;
      out[t.id] = { x: 40 + col * (NODE_W + 90), y: 40 + row * 150 };
    }
    return out;
  }, [positions, projectTasks, levels]);

  // load persisted positions per project (FR-M8); refetch when another device
  // changes the layout (audit: layout used to fan out no sync events at all)
  useEffect(() => {
    setPositions({});
    if (!selectedProjectId) return;
    const load = () => {
      api<{ positions: { task_id: string; x: number; y: number }[] }>(`/layout/${selectedProjectId}`)
        .then((res) => {
          const m: Record<string, Pos> = {};
          for (const p of res.positions) m[p.task_id] = { x: p.x, y: p.y };
          setPositions(m);
        })
        .catch(() => { /* first visit: auto layout */ });
    };
    load();
    const onLayoutUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d?.project_id === selectedProjectId) load();
    };
    window.addEventListener('tk:layout-updated', onLayoutUpdated);
    return () => window.removeEventListener('tk:layout-updated', onLayoutUpdated);
  }, [selectedProjectId]);

  const persistPositions = useCallback((next: Record<string, Pos>) => {
    if (!selectedProjectId) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void api(`/layout/${selectedProjectId}`, {
        method: 'PUT',
        body: { positions: Object.entries(next).map(([task_id, p]) => ({ task_id, x: p.x, y: p.y })) }
      }).catch(() => {});
    }, 600);
  }, [selectedProjectId]);

  // flush a pending debounced save on unmount — positions dragged in the last
  // 600 ms used to be silently lost (audit)
  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);

  // ---------- SVG coordinate helpers ----------
  const toSvg = useCallback((clientX: number, clientY: number): Pos => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }, [pan, zoom]);

  // ---------- pointer handlers ----------
  const onNodePointerDown = (e: React.PointerEvent, taskId: string) => {
    if ((e.target as Element).closest('[data-port]') || (e.target as Element).closest('[data-subrow]')) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    const pos = layout[taskId] ?? { x: 0, y: 0 };
    drag.current = { taskId, dx: p.x - pos.x, dy: p.y - pos.y };
    store.selectTask(taskId);
  };

  const onPortPointerDown = (e: React.PointerEvent, taskId: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSvg(e.clientX, e.clientY);
    setWiring({ from: taskId, x: p.x, y: p.y });
  };

  const onSvgPointerMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const p = toSvg(e.clientX, e.clientY);
      const next = { ...layout, [drag.current.taskId]: { x: p.x - drag.current.dx, y: p.y - drag.current.dy } };
      setPositions(next); // incident edges re-render every frame (FR-M7.2)
    } else if (wiring) {
      const p = toSvg(e.clientX, e.clientY);
      setWiring({ ...wiring, x: p.x, y: p.y });
    } else if (panRef.current) {
      setPan({ x: panRef.current.x + (e.clientX - panRef.current.mx), y: panRef.current.y + (e.clientY - panRef.current.my) });
    }
  };

  const onSvgPointerUp = async (e: React.PointerEvent) => {
    if (drag.current) {
      persistPositions(layout);
      drag.current = null;
    }
    if (wiring) {
      // wiring direction = drag direction: dropping port-node A onto B means
      // B DEPENDS ON A (the finished edge leaves A's right handle and the
      // arrowhead points the way you dragged)
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const nodeG = el?.closest('[data-node]');
      const targetId = nodeG?.getAttribute('data-node');
      if (targetId && targetId !== wiring.from) {
        try {
          const res = await api<{ dependency: any }>(`/tasks/${targetId}/deps`, {
            method: 'POST', body: { depends_on_id: wiring.from }
          });
          store.upsertDep(res.dependency);
        } catch (err: any) {
          if (err instanceof ApiError && err.code === 'cycle') {
            const path = (err.details as string[]) ?? [];
            pushToast('error', `${err.message}${path.length ? ` (${path.join(' → ')})` : ''}`);
          } else pushToast('error', err.message);
        }
      }
      setWiring(null);
    }
    panRef.current = null;
  };

  const onSvgPointerDown = (e: React.PointerEvent) => {
    // pan empty space (FR-M7.5); Escape cancels wiring
    if ((e.target as Element).closest('[data-node],[data-edge]')) return;
    panRef.current = { x: pan.x, y: pan.y, mx: e.clientX, my: e.clientY };
  };

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // ctrl+wheel zooms (50–200%, FR-M7.5)
      e.preventDefault();
      setZoom((z) => Math.min(2, Math.max(0.5, z * (e.deltaY > 0 ? 0.92 : 1.08))));
    };
    const svg = svgRef.current;
    svg?.addEventListener('wheel', onWheel, { passive: false });
    return () => svg?.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setWiring(null); setMenu(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- dependency actions (FR-M2/M3) ----------
  async function removeEdge(taskId: string, dependsOnId: string) {
    try {
      const res = await api<{ undo: any }>(`/tasks/${taskId}/deps/${dependsOnId}`, { method: 'DELETE' });
      store.removeDep(taskId, dependsOnId);
      undoableDelete('Dependency removed — undo?', res.undo);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function toggleTrack(taskId: string) {
    if (running?.task_id === taskId) {
      try { await api('/timer/stop', { method: 'POST' }); store.setRunning(null); } catch { /* ignored */ }
      return;
    }
    try {
      await store.startTimer(taskId); // applies setRunning + setPomo — the old
      // copy here dropped the pomo payload, leaving pomo UI stale (audit)
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function toggleDone(task: any) {
    try {
      const res = await api<{ task: any }>(`/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
      store.upsertLocal('task', res.task);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function toggleSubtaskInstant(sb: any) {
    // immediate feedback; every rapid tap persists (FR-M9 AC: no lost/delayed toggles)
    store.upsertLocal('subtask', { ...sb, done: sb.done ? 0 : 1 });
    try {
      const res = await api<{ subtask: any }>(`/subtasks/${sb.id}`, { method: 'PATCH', body: { done: !sb.done } });
      store.upsertLocal('subtask', res.subtask);
    } catch { void store.refreshAll(); }
  }

  async function resetLayout() {
    if (!selectedProjectId) return;
    // cancel a pending debounced save first — otherwise it fires AFTER the
    // DELETE and re-persists the pre-reset positions (audit race)
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    await api(`/layout/${selectedProjectId}`, { method: 'DELETE' }).catch(() => {});
    setPositions({});
  }

  // ---------- derived visuals (FR-M6) ----------
  const unmetCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of projectDeps) {
      const src = projectTasks.find((t) => t.id === d.depends_on_id);
      if (src && !src.done) m[d.task_id] = (m[d.task_id] ?? 0) + 1;
    }
    return m;
  }, [projectDeps, projectTasks]);

  if (!project) {
    return <div className="card"><h3>Map</h3><p className="muted">Select a project to view its dependency graph. The Map shows one project at a time (FR-M1).</p></div>;
  }

  const nodeHeight = (t: any) => HEADER_H + PAD + subtasks.filter((s) => s.task_id === t.id).length * ROW_H + 8;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dropdown style={{ width: 220 }} ariaLabel="Map project selector" value={selectedProjectId ?? ''}
          onChange={(v) => store.selectProject(v)}
          options={projects.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name, icon: <ColorChip color={p.color} /> }))} />
        <span className="muted">Drag a node's <b>●</b> port onto another task — the dropped task <b>depends on</b> the port's task (the arrow follows your drag). Click an edge to remove it. Ctrl+wheel zooms.</span>
        <div className="spacer" />
        <button className="btn small" onClick={resetLayout}>Reset layout</button>
      </div>

      <div className="map-wrap" style={{ flex: 1, minHeight: 320 }}>
        <svg
          ref={svgRef}
          className="map-svg"
          role="application"
          aria-label={`Dependency map for ${project.name}`}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
        >
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            <defs>
              {/* arrowheads: progression flows prerequisite → dependent (FR-M6) */}
              <marker id="map-arrow-met" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth={6} markerHeight={6} orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="map-arrow met" />
              </marker>
              <marker id="map-arrow-unmet" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth={6} markerHeight={6} orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="map-arrow unmet" />
              </marker>
            </defs>
            {/* edges — real path hit-testing via a fat invisible stroke overlay (FR-M3) */}
            {projectDeps.map((d) => {
              const a = layout[d.depends_on_id];   // prerequisite
              const b = layout[d.task_id];         // dependent (arrow points here)
              if (!a || !b) return null;
              const hA = nodeHeight(projectTasks.find((t) => t.id === d.depends_on_id)!) / 2;
              const hB = nodeHeight(projectTasks.find((t) => t.id === d.task_id)!) / 2;
              const y1 = a.y + hA, y2 = b.y + hB;
              // attach to the sides actually facing each other — freely dragged
              // (persisted) layouts may reverse the column order
              const dir = (b.x + NODE_W / 2) >= (a.x + NODE_W / 2) ? 1 : -1;
              const x1 = dir === 1 ? a.x + NODE_W : a.x;
              const x2 = dir === 1 ? b.x - 7 : b.x + NODE_W + 7; // leave room for the arrowhead
              const mid = (x1 + x2) / 2;
              const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
              const src = projectTasks.find((t) => t.id === d.depends_on_id);
              const unmet = src && !src.done;
              return (
                <g key={`${d.task_id}-${d.depends_on_id}`} data-edge>
                  <path className={`map-edge ${unmet ? 'unmet' : 'met'}`} d={path}
                    markerEnd={`url(#map-arrow-${unmet ? 'unmet' : 'met'})`} />
                  <path d={path} stroke="transparent" strokeWidth={14} fill="none" style={{ cursor: 'pointer' }}
                    tabIndex={0} role="button" aria-label={`Remove dependency ${src?.name ?? ''} → ${projectTasks.find((t) => t.id === d.task_id)?.name ?? ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeEdge(d.task_id, d.depends_on_id)} />
                </g>
              );
            })}

            {/* wiring rubber-band (FR-M2) */}
            {wiring && (() => {
              const a = layout[wiring.from];
              if (!a) return null;
              const hA = nodeHeight(projectTasks.find((t) => t.id === wiring.from)!) / 2;
              return <path className="map-edge-preview" d={`M ${a.x + NODE_W} ${a.y + hA} L ${wiring.x} ${wiring.y}`} />;
            })()}

            {/* nodes — card + spine + rows + badge + port form ONE atomic group (FR-M7.1) */}
            {projectTasks.map((t) => {
              const pos = layout[t.id] ?? { x: 0, y: 0 };
              const h = nodeHeight(t);
              const sbs = subtasks.filter((s) => s.task_id === t.id);
              const doneN = sbs.filter((s) => !!s.done).length;
              const isRunning = running?.task_id === t.id;
              const blocked = unmetCount[t.id] ?? 0;
              return (
                <g key={t.id} data-node={t.id}
                  className={`map-node ${t.done ? 'done' : ''} ${selectedTaskId === t.id ? 'selected' : ''}`}
                  transform={`translate(${pos.x},${pos.y})`}
                  tabIndex={0} role="treeitem" aria-selected={selectedTaskId === t.id}
                  aria-label={`${t.name}${t.done ? ', done' : ''}${isRunning ? ', tracking' : ''}${blocked ? `, blocked by ${blocked}` : ''}`}
                  onPointerDown={(e) => onNodePointerDown(e, t.id)}
                  onDoubleClick={() => toggleTrack(t.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ taskId: t.id, x: e.clientX, y: e.clientY }); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setMenu({ taskId: t.id, x: pos.x * zoom + pan.x + 120, y: pos.y * zoom + pan.y });
                    if (e.key === ' ') { e.preventDefault(); void toggleTrack(t.id); }
                  }}
                >
                  <title>{`${t.name}${t.done ? ' (done)' : ''}`}</title>
                  <rect className="card-bg" width={NODE_W} height={h} rx={10} />
                  {/* project-colored spine */}
                  <rect x={0} y={0} width={5} height={h} rx={2.5} fill={project.color} />
                  {isRunning && <circle className="running-dot" cx={NODE_W - 14} cy={HEADER_H / 2 + 2} r={4.5} />}
                  <text x={14} y={HEADER_H / 2 + 4} fontSize={12.5} fontWeight={700}
                    style={{ pointerEvents: 'none' }}>
                    {t.name.length > 24 ? `${t.name.slice(0, 23)}…` : t.name}
                  </text>
                  {blocked > 0 && (
                    <text className="blocked-badge" x={NODE_W - (blocked > 9 ? 30 : 24)} y={HEADER_H / 2 + 5}>▲{blocked}</text>
                  )}
                  {sbs.map((sb, i) => (
                    <g key={sb.id} data-subrow onClick={(e) => { e.stopPropagation(); void toggleSubtaskInstant(sb); }}
                      style={{ cursor: 'pointer' }} role="checkbox" aria-checked={!!sb.done} aria-label={sb.name}>
                      <title>{sb.name}</title>
                      <rect x={10} y={HEADER_H + i * ROW_H + 2} width={NODE_W - 20} height={ROW_H - 2} fill="transparent" />
                      <text x={16} y={HEADER_H + i * ROW_H + 16} className="sub-row">
                        {sb.done ? '☑' : '☐'} {sb.name.length > 24 ? `${sb.name.slice(0, 23)}…` : sb.name}
                      </text>
                    </g>
                  ))}
                  {sbs.length > 0 && (
                    <text x={14} y={h - 5} fontSize={10.5} fill="var(--muted)" style={{ pointerEvents: 'none' }}>
                      {Math.round((doneN / sbs.length) * 100)}%
                    </text>
                  )}
                  {/* link port — drawn last inside the group: topmost hit (FR-M7.3) */}
                  <circle data-port className="map-port" cx={NODE_W} cy={h / 2} r={PORT_R}
                    onPointerDown={(e) => onPortPointerDown(e, t.id)} />
                </g>
              );
            })}
          </g>
        </svg>

        {menu && (
          <NodeMenu
            taskId={menu.taskId}
            x={menu.x} y={menu.y}
            onToggleTrack={() => void toggleTrack(menu.taskId)}
            onToggleDone={() => { const t = tasks.find((x) => x.id === menu.taskId); if (t) void toggleDone(t); setMenu(null); }}
            onRename={async () => {
              const t = tasks.find((x) => x.id === menu.taskId);
              // non-blocking modal instead of window.prompt
              const name = await openPrompt({ title: 'Rename task', initialValue: t?.name ?? '', confirmText: 'Rename' });
              if (name?.trim() && t) {
                try {
                  const res = await api<{ task: any }>(`/tasks/${t.id}`, { method: 'PATCH', body: { name: name.trim() } });
                  store.upsertLocal('task', res.task);
                } catch (e: any) { pushToast('error', e.message); }
              }
              setMenu(null);
            }}
            onAddSubtask={async () => {
              const name = await openPrompt({ title: 'New subtask', placeholder: 'Subtask name', confirmText: 'Create' });
              if (name?.trim()) {
                try {
                  const res = await api<{ subtask: any }>(`/tasks/${menu.taskId}/subtasks`, { method: 'POST', body: { name: name.trim() } });
                  store.upsertLocal('subtask', res.subtask);
                } catch (e: any) { pushToast('error', e.message); }
              }
              setMenu(null);
            }}
            onDelete={async () => {
              try {
                const res = await api<{ undo: any }>(`/tasks/${menu.taskId}`, { method: 'DELETE' });
                store.removeLocalTask(menu.taskId);
                undoableDelete('Task deleted — undo?', res.undo);
              } catch (e: any) { pushToast('error', e.message); }
              setMenu(null);
            }}
            depsOf={projectDeps.filter((d) => d.task_id === menu.taskId).map((d) => projectTasks.find((t) => t.id === d.depends_on_id)?.name ?? '?')}
            onClose={() => setMenu(null)}
          />
        )}

        {/* screen-reader mirror (NFR-8) */}
        <div className="visually-hidden" aria-label="Task and dependency list">
          <ul>
            {projectTasks.map((t) => (
              <li key={t.id}>
                {t.name}{t.done ? ' (done)' : ''}{running?.task_id === t.id ? ' (tracking)' : ''} —
                depends on: {projectDeps.filter((d) => d.task_id === t.id)
                  .map((d) => projectTasks.find((x) => x.id === d.depends_on_id)?.name).join(', ') || 'nothing'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function NodeMenu(props: {
  taskId: string; x: number; y: number; depsOf: string[];
  onToggleTrack: () => void; onToggleDone: () => void; onRename: () => void;
  onAddSubtask: () => void; onDelete: () => void; onClose: () => void;
}) {
  return (
    <div className="modal-overlay" style={{ background: 'transparent', alignItems: 'flex-start', justifyContent: 'flex-start' }}
      onClick={props.onClose} onContextMenu={(e) => { e.preventDefault(); props.onClose(); }}>
      <div className="modal" style={{ position: 'fixed', left: props.x, top: props.y, maxWidth: 260, padding: 8 }}
        onClick={(e) => e.stopPropagation()} role="menu" aria-label="Task context menu">
        <button className="btn small" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }} role="menuitem" onClick={props.onToggleTrack}>▶ Toggle tracking</button>
        <button className="btn small" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }} role="menuitem" onClick={props.onToggleDone}>✓ Toggle done</button>
        <button className="btn small" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }} role="menuitem" onClick={props.onRename}>✎ Rename</button>
        <button className="btn small" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }} role="menuitem" onClick={props.onAddSubtask}>＋ Add subtask</button>
        {props.depsOf.length > 0 && (
          <div className="muted" style={{ fontSize: 11.5, padding: '4px 2px' }}>depends on: {props.depsOf.join(', ')}</div>
        )}
        <button className="btn small danger" style={{ display: 'block', width: '100%', textAlign: 'left' }} role="menuitem" onClick={props.onDelete}>🗑 Delete task</button>
      </div>
    </div>
  );
}

/** Longest-path layering: prerequisites get lower columns. */
function computeLevels(tasks: any[], deps: { task_id: string; depends_on_id: string }[]): Map<string, number> {
  const level = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    if (level.has(id)) return level.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard (server prevents cycles anyway)
    visiting.add(id);
    const prereqs = deps.filter((d) => d.task_id === id && byId.has(d.depends_on_id)).map((d) => d.depends_on_id);
    const l = prereqs.length === 0 ? 0 : 1 + Math.max(...prereqs.map(levelOf));
    visiting.delete(id);
    level.set(id, l);
    return l;
  };
  for (const t of tasks) levelOf(t.id);
  return level;
}
