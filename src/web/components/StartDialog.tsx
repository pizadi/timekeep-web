// Start dialog (B): keyboard-driven timer start — search a task or subtask,
// Enter begins tracking (auto-switches when something already runs, via
// startTimer's fallback). Modeled on QuickFind and shares its .qf-overlay
// styles — which also makes the shortcut suppressors treat it as a modal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';

interface Hit {
  key: string;
  taskId: string;
  subtaskId: string | null;
  label: string;
  hint: string; // context: project name (tasks) or "task ▸ project" (subtasks)
  color: string;
  rank: number; // recency rank from recentEntries — lower = more recent
}

export default function StartDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const recentEntries = useStore((s) => s.recentEntries);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<Hit[]>(() => {
    const rank = new Map(recentEntries.map((e, i) => [e.task_id, i]));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const needle = q.trim().toLowerCase();
    const hits: Hit[] = [];
    for (const t of tasks) {
      const p = projects.find((x) => x.id === t.project_id);
      hits.push({
        key: `t-${t.id}`,
        taskId: t.id,
        subtaskId: null,
        label: t.name,
        hint: p?.name ?? '',
        color: p?.color ?? '#888',
        rank: rank.get(t.id) ?? Number.POSITIVE_INFINITY,
      });
    }
    for (const sb of subtasks) {
      const t = taskById.get(sb.task_id);
      if (!t) continue;
      const p = projects.find((x) => x.id === t.project_id);
      hits.push({
        key: `s-${sb.id}`,
        taskId: t.id,
        subtaskId: sb.id,
        label: sb.name,
        hint: `${t.name} ▸ ${p?.name ?? ''}`,
        color: p?.color ?? '#888',
        rank: rank.get(t.id) ?? Number.POSITIVE_INFINITY,
      });
    }
    return hits
      .filter((h) => !needle || h.label.toLowerCase().includes(needle) || h.hint.toLowerCase().includes(needle))
      .sort((a, b) => a.rank - b.rank) // stable: store order within equal ranks
      .slice(0, 30);
  }, [q, tasks, subtasks, projects, recentEntries]);

  async function commit(i: number) {
    const hit = results[i];
    if (!hit) return;
    try {
      store.selectTask(hit.taskId);
      await store.startTimer(hit.taskId, hit.subtaskId);
      onClose(); // the TimerBar flipping to its running state is the confirmation
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  return (
    <div className="qf-overlay" onClick={onClose}>
      <div className="qf" role="dialog" aria-label="Start timer" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Start tracking a task or subtask…"
          aria-label="Search tasks and subtasks to start tracking"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
            if (e.key === 'Enter') void commit(active);
          }}
        />
        {results.map((r, i) => (
          <div
            key={r.key}
            className={`item${i === active ? ' active' : ''}`}
            title={r.hint ? `${r.label} — ${r.hint}` : r.label}
            onMouseEnter={() => setActive(i)}
            onClick={() => void commit(i)}
          >
            <span className="chip" style={{ background: r.color }} />
            <span className="grow">{r.label}</span>
            <span className="muted">{r.hint}</span>
          </div>
        ))}
        {results.length === 0 && <div className="item muted">No matches</div>}
      </div>
    </div>
  );
}
