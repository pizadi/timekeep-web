// Quick find (FR-T6, Ctrl/Cmd+K): filter projects/tasks by name, jump to selection.
import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore } from '../lib/store';

export default function QuickFind({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const projHits = projects.filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .slice(0, 4)
      .map((p) => ({ kind: 'project' as const, id: p.id, name: p.name, color: p.color }));
    const taskHits = tasks.filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .slice(0, 10)
      .map((t) => ({
        kind: 'task' as const, id: t.id, name: t.name,
        color: projects.find((p) => p.id === t.project_id)?.color ?? '#888'
      }));
    return [...projHits, ...taskHits];
  }, [q, projects, tasks]);

  function commit(i: number) {
    const hit = results[i];
    if (!hit) return;
    if (hit.kind === 'project') store.selectProject(hit.id);
    else {
      store.selectTask(hit.id);
      const t = tasks.find((x) => x.id === hit.id);
      if (t) store.selectProject(t.project_id);
    }
    store.navigateToView(hit.kind === 'task' ? 'map' : 'tree'); // URL sync (audit: setView desynced the URL)
    onClose();
  }

  return (
    <div className="qf-overlay" onClick={onClose}>
      <div className="qf" role="dialog" aria-label="Quick find" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Jump to project or task…"
          aria-label="Search projects and tasks"
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') commit(active);
          }}
        />
        {results.map((r, i) => (
          <div key={`${r.kind}-${r.id}`} className={`item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)} onClick={() => commit(i)}>
            <span className="chip" style={{ background: r.color }} />
            <span className="grow">{r.name}</span>
            <span className="muted">{r.kind}</span>
          </div>
        ))}
        {results.length === 0 && <div className="item muted">No matches</div>}
      </div>
    </div>
  );
}
