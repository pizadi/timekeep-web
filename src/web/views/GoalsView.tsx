// Goals (v0.6.0): set "X hours per period on Z" targets and track them. All
// numbers come from /goals/progress (server-side buckets — the client never
// derives tracked time itself), refetched on the same events that move reports
// (reportsVersion) so a running timer on a scoped task keeps the bar moving.
// Status is derived server-side from live data: completed goals re-activate
// when a scope item is unchecked. Responsive rules: every action is a real
// button (touch-safe), no hover-only affordances, truncation carries tooltips.
import { useCallback, useEffect, useState } from 'react';
import { useStore, pushToast } from '../lib/store';
import { api } from '../lib/api';
import { useModalA11y } from '../lib/modal';
import Dropdown from '../components/Dropdown';
import Combobox, { type ComboboxGroup } from '../components/Combobox';
import { addGoal, updateGoal, deleteGoalWithUndo, type GoalInput } from '../lib/actions';
import { fmtTarget, parseScopeRef, makeScopeRef, windowMet, type Goal, type GoalStatus } from '../../shared/goals';
import { fmtDateTime, toLocalInput, fromLocalInput } from '../lib/time';

type Stats = {
  periods: number;
  met: number;
  missed: number;
  hitRate: number;
  currentStreak: number;
  bestStreak: number;
  avgMinutes: number;
  overshoots: number;
  avgOvershoot: number;
  totalMinutes: number;
};
type WindowRow = { start: number; end: number; target: number; actual: number; elapsed: boolean; current: boolean };
type ProgressEntry = { goal: Goal; status: GoalStatus; scope_empty: boolean; windows: WindowRow[]; stats: Stats };

function fmtMinutes(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export default function GoalsView() {
  const user = useStore((s) => s.user)!;
  const reportsVersion = useStore((s) => s.reportsVersion);
  const [progress, setProgress] = useState<ProgressEntry[] | null>(null);
  const [editor, setEditor] = useState<'new' | Goal | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ goals: ProgressEntry[] }>('/goals/progress?windows=12');
      setProgress(r.goals);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }, []);

  // same invalidation rhythm as the dashboard: relevant events bump
  // reportsVersion (timer start/stop, session edits) → the bar stays live
  useEffect(() => {
    void load();
  }, [load, reportsVersion]);

  const active = (progress ?? []).filter((p) => p.status === 'active');
  const settled = (progress ?? []).filter((p) => p.status !== 'active');

  return (
    <div>
      <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ flex: 1, marginBottom: 0 }}>
          Goals{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            — time targets per day, week or month
          </span>
        </h3>
        <button className="btn small primary" onClick={() => setEditor('new')}>
          ＋ New goal
        </button>
      </div>

      {progress === null && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Loading goals…
          </p>
        </div>
      )}

      {progress !== null && active.length === 0 && settled.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No goals yet — use ＋ New goal to set your first target, e.g. “spend 10h per week on Project X”.
          </p>
        </div>
      )}

      {active.map((entry) => (
        <GoalCard key={entry.goal.id} entry={entry} onEdit={() => setEditor(entry.goal)} />
      ))}

      {settled.length > 0 && (
        <details className="card" style={{ padding: '10px 16px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
            Completed &amp; past goals <span className="muted">({settled.length})</span>
          </summary>
          <div style={{ marginTop: 10 }}>
            {settled.map((entry) => (
              <GoalCard key={entry.goal.id} entry={entry} onEdit={() => setEditor(entry.goal)} />
            ))}
          </div>
        </details>
      )}

      {editor !== null && (
        <GoalEditor
          goal={editor === 'new' ? null : editor}
          tz={user.timezone}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------- goal card ----------

function GoalCard({ entry, onEdit }: { entry: ProgressEntry; onEdit: () => void }) {
  const goal = entry.goal;
  const isActive = entry.status === 'active';
  const cur = entry.windows.find((w) => w.current);
  const over = cur !== undefined && cur.actual > cur.target;
  const pct = cur ? Math.min(100, Math.round((cur.actual / Math.max(1, cur.target)) * 100)) : 0;
  const periodNoun = goal.period === 'day' ? 'days' : goal.period === 'week' ? 'weeks' : 'months';

  return (
    <div className="card" style={{ opacity: isActive ? undefined : 0.75 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b
          className="grow"
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={goal.name || undefined}
        >
          {goal.name || fmtTarget(goal)}
        </b>
        <StatusBadge status={entry.status} />
        {isActive && <span className="badge">{fmtTarget(goal)}</span>}
      </div>
      <ScopeSummary refs={goal.scope} />
      {entry.scope_empty && isActive && (
        <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
          ⚠ Every item in this goal's scope was deleted — edit the goal to pick new ones.
        </p>
      )}

      {isActive && cur && (
        <div style={{ marginTop: 10 }}>
          <div
            className="goal-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cur.target}
            aria-valuenow={cur.actual}
            aria-label={`${fmtMinutes(cur.actual)} of ${fmtMinutes(cur.target)} this ${goal.period}`}
          >
            <div className={`goal-bar-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <span className="sub">
              {fmtMinutes(cur.actual)} of {fmtMinutes(cur.target)} this {goal.period}
              {cur.actual > cur.target ? ` (+${fmtMinutes(cur.actual - cur.target)})` : ''}
            </span>
            <span className="spacer" />
            <span className="sub" title="Current streak · best streak">
              🔥 {entry.stats.currentStreak} · best {entry.stats.bestStreak}
            </span>
          </div>
        </div>
      )}

      {entry.stats.periods > 0 && (
        <p className="sub" style={{ margin: '8px 0 0' }}>
          Met {entry.stats.met} of {entry.stats.periods} {periodNoun} ({entry.stats.hitRate}%) · avg{' '}
          {fmtMinutes(entry.stats.avgMinutes)}
          {entry.stats.overshoots > 0
            ? ` · ${goal.direction === 'at_least' ? 'beat the target' : 'over the limit'} ${entry.stats.overshoots}× by ${fmtMinutes(entry.stats.avgOvershoot)} on average`
            : ''}{' '}
          · {fmtMinutes(entry.stats.totalMinutes)} total
        </p>
      )}

      {entry.windows.length > 0 && <WindowStrip windows={entry.windows} goal={goal} />}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={onEdit}>
          Edit
        </button>
        {isActive && (
          <button className="btn small" onClick={() => void updateGoal(goal.id, { archived: true })}>
            Archive
          </button>
        )}
        {goal.archived_at !== null && (
          <button className="btn small" onClick={() => void updateGoal(goal.id, { archived: false })}>
            Un-archive
          </button>
        )}
        <button className="btn small" onClick={() => void deleteGoalWithUndo(goal)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: GoalStatus }) {
  if (status === 'active') return null;
  const map: Record<Exclude<GoalStatus, 'active'>, { label: string; cls: string }> = {
    completed: { label: '✓ Completed', cls: 'goal-badge-ok' },
    expired: { label: 'Expired', cls: '' },
    archived: { label: 'Archived', cls: '' },
  };
  const it = map[status]!;
  return <span className={`badge ${it.cls}`}>{it.label}</span>;
}

/** Last N periods as ✓/✗/• cells — every cell carries a title tooltip
 *  (truncation policy: tooltips work on touch too). */
function WindowStrip({ windows, goal }: { windows: WindowRow[]; goal: Goal }) {
  return (
    <div className="goal-strip" style={{ marginTop: 10 }} aria-label={`Last ${windows.length} ${goal.period}s`}>
      {windows.map((w) => {
        const met = windowMet(goal.direction, w.actual, w.target);
        const label = w.current
          ? 'in progress'
          : met
            ? goal.direction === 'at_least'
              ? `target met (${fmtMinutes(w.actual)} of ${fmtMinutes(w.target)})`
              : `stayed under (${fmtMinutes(w.actual)} of ${fmtMinutes(w.target)})`
            : goal.direction === 'at_least'
              ? `missed (${fmtMinutes(w.actual)} of ${fmtMinutes(w.target)})`
              : `over the limit (${fmtMinutes(w.actual)} of ${fmtMinutes(w.target)})`;
        return (
          <span
            key={w.start}
            className={`goal-cell${w.current ? ' current' : met ? ' met' : ' missed'}`}
            title={`${periodTitle(w, goal)} — ${label}`}
            aria-label={`${periodTitle(w, goal)}: ${label}`}
          >
            {w.current ? '•' : met ? '✓' : '✗'}
          </span>
        );
      })}
    </div>
  );
}

/** Human label for a window's period start (w.start is the civil period open). */
function periodTitle(w: WindowRow, goal: Goal): string {
  const d = new Date(w.start);
  if (goal.period === 'month') return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  if (goal.period === 'day') return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  return `week of ${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`;
}

/** One-line scope summary: names of the referenced nodes (tombstoned ones show
 *  as "deleted …" — the client no longer has their names). */
function ScopeSummary({ refs }: { refs: string[] }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const names = refs.slice(0, 4).map((ref) => refName(ref, projects, tasks, subtasks));
  const more = refs.length - names.length;
  return (
    <p className="sub" style={{ margin: '2px 0 0' }} title={names.join(', ')}>
      {names.join(' · ')}
      {more > 0 ? ` · +${more} more` : ''}
    </p>
  );
}

// ---------- editor modal ----------

function GoalEditor({
  goal,
  tz,
  onClose,
  onSaved,
}: {
  goal: Goal | null; // null = create
  tz: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const modalRef = useModalA11y(onClose);
  const [name, setName] = useState(goal?.name ?? '');
  const [direction, setDirection] = useState<'at_least' | 'at_most'>(goal?.direction ?? 'at_least');
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(goal?.period ?? 'week');
  const [hours, setHours] = useState(String(Math.floor((goal?.target_minutes ?? 600) / 60)));
  const [mins, setMins] = useState(String((goal?.target_minutes ?? 600) % 60));
  const [refs, setRefs] = useState<string[]>(goal?.scope ?? []);
  const [endsAt, setEndsAt] = useState(goal?.ends_at ? toLocalInput(goal.ends_at, tz) : '');
  const [saving, setSaving] = useState(false);

  const target = Number(hours) * 60 + Number(mins);
  const valid = refs.length > 0 && Number.isInteger(target) && target >= 1 && target <= 20160;

  async function save(): Promise<void> {
    if (!valid || saving) return;
    setSaving(true);
    const payload: GoalInput = {
      name: name.trim(),
      period,
      direction,
      target_minutes: target,
      scope: refs,
      ends_at: endsAt ? fromLocalInput(endsAt, tz) : null,
    };
    try {
      if (goal) await updateGoal(goal.id, payload);
      else await addGoal(payload);
      onSaved();
    } catch (e: any) {
      pushToast('error', e.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Goal editor" onClick={onClose}>
      <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{goal ? 'Edit goal' : 'New goal'}</h3>

        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="sub">Name (optional)</span>
            <input
              className="input"
              value={name}
              maxLength={80}
              placeholder={`e.g. “Deep work” — defaults to “${direction === 'at_least' ? 'at least' : 'at most'} target”`}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 0 }}>
              <span className="sub">I will spend…</span>
              <Dropdown
                ariaLabel="Direction"
                value={direction}
                onChange={(v) => setDirection(v as 'at_least' | 'at_most')}
                options={[
                  { value: 'at_least', label: 'at least (habit)' },
                  { value: 'at_most', label: 'at most (limit)' },
                ]}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 0 }}>
              <span className="sub">…per…</span>
              <Dropdown
                ariaLabel="Period"
                value={period}
                onChange={(v) => setPeriod(v as 'day' | 'week' | 'month')}
                options={[
                  { value: 'day', label: 'day' },
                  { value: 'week', label: 'week' },
                  { value: 'month', label: 'month' },
                ]}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span className="sub">Hours</span>
              <StepField label="Target hours" value={hours} onValue={setHours} step={1} min={0} max={336} />
            </div>
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span className="sub">Minutes</span>
              <StepField label="Target minutes" value={mins} onValue={setMins} step={5} min={0} max={59} />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <span className="sub">…doing (pick projects, tasks or subtasks — at least one)</span>
            <ScopePicker refs={refs} onChange={setRefs} />
          </div>

          <label style={{ display: 'grid', gap: 4 }}>
            <span className="sub">Ends on (optional — the final period is shortened accordingly)</span>
            <input
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              aria-label="Goal end date"
            />
            {endsAt && (
              <span className="sub">
                {fmtDateTime(fromLocalInput(endsAt, tz), tz)} ·{' '}
                <button
                  className="btn ghost small"
                  style={{ padding: 0 }}
                  onClick={() => setEndsAt('')}
                  aria-label="Clear end date"
                >
                  clear
                </button>
              </span>
            )}
          </label>
        </div>

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || saving} onClick={() => void save()}>
            {goal ? 'Save' : 'Create goal'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- scope picker ----------

/** Scope-ref name resolution (tombstoned items have no live name). */
function refName(
  ref: string,
  projects: { id: string; name: string }[],
  tasks: { id: string; name: string }[],
  subtasks: { id: string; name: string }[],
): string {
  const r = parseScopeRef(ref);
  if (!r) return '?';
  if (r.kind === 'project') return projects.find((p) => p.id === r.id)?.name ?? 'deleted project';
  if (r.kind === 'task') return tasks.find((t) => t.id === r.id)?.name ?? 'deleted task';
  return subtasks.find((sb) => sb.id === r.id)?.name ?? 'deleted subtask';
}

/** The ancestor ref that already covers `ref`, if any (project ⊃ task ⊃ subtask). */
function coveredBy(
  ref: string,
  refs: string[],
  tasks: { id: string; project_id: string }[],
  subtasks: { id: string; task_id: string }[],
): string | null {
  const r = parseScopeRef(ref);
  if (!r) return null;
  if (r.kind === 'task') {
    const t = tasks.find((x) => x.id === r.id);
    if (t && refs.includes(makeScopeRef('project', t.project_id))) return makeScopeRef('project', t.project_id);
  }
  if (r.kind === 'subtask') {
    const sb = subtasks.find((x) => x.id === r.id);
    if (!sb) return null;
    if (refs.includes(makeScopeRef('task', sb.task_id))) return makeScopeRef('task', sb.task_id);
    const t = tasks.find((x) => x.id === sb.task_id);
    if (t && refs.includes(makeScopeRef('project', t.project_id))) return makeScopeRef('project', t.project_id);
  }
  return null;
}

/**
 * Scope = search-driven picker (Combobox — the house replacement for unthemeable
 * native suggestion controls) + removable chips for what is selected. Picking a
 * project covers ALL its tasks (now and future); a pick already covered by an
 * ancestor chip is refused with a hint, and a project pick supersedes explicit
 * descendants. Focusing the input with an empty query lists everything, grouped
 * project→task→subtask — so browsing needs no tree either.
 */
function ScopePicker({ refs, onChange }: { refs: string[]; onChange: (refs: string[]) => void }) {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const subtasks = useStore((s) => s.subtasks);
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  const liveProjects = projects.filter((p) => !p.archived);
  const liveProjectIds = new Set(liveProjects.map((p) => p.id));
  const liveTasks = tasks.filter((t) => liveProjectIds.has(t.project_id));
  const liveTaskIds = new Set(liveTasks.map((t) => t.id));
  const liveSubs = subtasks.filter((sb) => liveTaskIds.has(sb.task_id));
  const colorOf = (projectId: string | undefined) => projects.find((p) => p.id === projectId)?.color;
  const taskOf = (id: string | undefined) => tasks.find((t) => t.id === id);

  const groups: ComboboxGroup[] = [
    {
      label: 'Projects',
      options: liveProjects.map((p) => ({
        value: makeScopeRef('project', p.id),
        label: p.name,
        color: p.color,
        hint: p.group_id ? 'group · whole project' : 'whole project',
      })),
    },
    {
      label: 'Tasks',
      options: liveTasks.map((t) => ({
        value: makeScopeRef('task', t.id),
        label: t.name,
        color: colorOf(t.project_id),
        hint: projects.find((p) => p.id === t.project_id)?.name,
      })),
    },
    {
      label: 'Subtasks',
      options: liveSubs.map((sb) => ({
        value: makeScopeRef('subtask', sb.id),
        label: sb.name,
        color: colorOf(taskOf(sb.task_id)?.project_id),
        hint: `${taskOf(sb.task_id)?.name ?? '?'} · ${projects.find((p) => p.id === taskOf(sb.task_id)?.project_id)?.name ?? '?'}`,
      })),
    },
  ];

  function pick(ref: string): void {
    setText('');
    if (refs.includes(ref)) {
      setHint('Already selected');
      return;
    }
    const covered = coveredBy(ref, refs, tasks, subtasks);
    if (covered) {
      setHint(
        `Already covered by “${refName(covered, projects, tasks, subtasks)}” — remove that chip first to narrow the scope`,
      );
      return;
    }
    const r = parseScopeRef(ref);
    if (r?.kind === 'project') {
      // a project pick supersedes explicit descendants (they'd be redundant)
      const childTaskIds = new Set(tasks.filter((t) => t.project_id === r.id).map((t) => t.id));
      const superseded = (x: string): boolean => {
        const rr = parseScopeRef(x);
        if (!rr) return false;
        if (rr.kind === 'task') return childTaskIds.has(rr.id);
        if (rr.kind === 'subtask') {
          const sb = subtasks.find((y) => y.id === rr.id);
          return sb !== undefined && childTaskIds.has(sb.task_id);
        }
        return false;
      };
      onChange([...refs.filter((x) => !superseded(x)), ref]);
    } else {
      onChange([...refs, ref]);
    }
    setHint(null);
  }

  return (
    <div className="scope-tree">
      <Combobox
        text={text}
        onTextChange={(v) => {
          setText(v);
          setHint(null);
        }}
        onPick={pick}
        groups={groups}
        placeholder="Search projects, tasks, subtasks…"
        ariaLabel="Search goal scope"
      />
      {hint && <span className="sub">{hint}</span>}
      {refs.length > 0 ? (
        <div className="goal-chips">
          {refs.map((ref) => {
            const r = parseScopeRef(ref);
            const name = refName(ref, projects, tasks, subtasks);
            const color =
              r?.kind === 'project'
                ? colorOf(r.id)
                : r?.kind === 'task'
                  ? colorOf(tasks.find((t) => t.id === r.id)?.project_id)
                  : colorOf(taskOf(subtasks.find((sb) => sb.id === r?.id)?.task_id)?.project_id);
            return (
              <span className="goal-chip" key={ref}>
                <span className="chip" style={{ background: color }} aria-hidden />
                <span className="scope-name" title={name}>
                  {name}
                </span>
                <span className="muted">{r?.kind}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${name} from goal scope`}
                  onClick={() => {
                    setHint(null);
                    onChange(refs.filter((x) => x !== ref));
                  }}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        !hint && <span className="sub">Pick at least one item — a project covers all its tasks.</span>
      )}
    </div>
  );
}

/** Themed stepper for number fields — native spin buttons are unthemeable
 *  (hidden app-wide), so values step via buttons or typing. */
function StepField({
  label,
  value,
  onValue,
  step,
  min,
  max,
}: {
  label: string;
  value: string;
  onValue: (v: string) => void;
  step: number;
  min: number;
  max: number;
}) {
  const bump = (d: number) => onValue(String(Math.min(max, Math.max(min, (Number(value) || 0) + d))));
  return (
    <div className="step-field">
      <button type="button" className="btn small" aria-label={`Decrease ${label}`} onClick={() => bump(-step)}>
        −
      </button>
      <input
        className="input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => onValue(e.target.value)}
      />
      <button type="button" className="btn small" aria-label={`Increase ${label}`} onClick={() => bump(step)}>
        ＋
      </button>
    </div>
  );
}
