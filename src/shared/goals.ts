// Goals (v0.6.0) — pure goal math. Shared so the worker (/goals/progress) and
// the client (GoalsView) compute identical numbers; test/goals.test.ts is the
// contract. All instants are epoch-ms UTC; day/week/month windows follow the
// user's IANA timezone (and week_start), same engine as reports (shared/time.ts).
//
// A goal = "spend X minutes per Y period doing Z" (Z = any mix of project/task/
// subtask nodes). Deactivation is DERIVED, never stored: archived (user action)
// / completed (every live scope item done) / expired (ends_at passed) — see
// goalStatus(). The first partial period and the expiry-clipped final period are
// both pro-rated by covered time (ceil, min 1 minute).
import { addDaysCivil, civilDate, dayStartInstant, weekStartInstant } from './time';

export const GOAL_PERIODS = ['day', 'week', 'month'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export const GOAL_DIRECTIONS = ['at_least', 'at_most'] as const;
export type GoalDirection = (typeof GOAL_DIRECTIONS)[number];

export type GoalScopeKind = 'project' | 'task' | 'subtask';
export const GOAL_SCOPE_KINDS: readonly GoalScopeKind[] = ['project', 'task', 'subtask'];

export interface Goal {
  id: string;
  user_id: string;
  name: string; // optional display name ('' → auto label)
  period: GoalPeriod;
  direction: GoalDirection;
  target_minutes: number;
  /** Scope refs as "kind:id" strings (validated + deduped at the edge). */
  scope: string[];
  ends_at: number | null;
  created_at: number;
  archived_at: number | null;
}

/** One period window of a goal's timeline. */
export interface GoalWindow {
  /** UTC instant the civil period opens. */
  start: number;
  /** UTC instant the civil period closes (before any clipping). */
  end: number;
  /** Pro-rated target in minutes (full target unless the goal's lifetime only
   *  partially covers this window). */
  target: number;
  /** Tracked minutes inside [start_clipped, end_clipped] — filled by the caller
   *  (server SQL; includes the running session clipped to `now`). */
  actual: number;
  /** The window is fully over at `now` (period passed or the goal expired). */
  elapsed: boolean;
  /** The in-progress window containing `now` (active goals only). */
  current: boolean;
}

export type GoalStatus = 'active' | 'completed' | 'expired' | 'archived';

export interface GoalScopeState {
  /** Live (non-tombstoned) tasks + subtasks the scope resolves to. */
  liveCount: number;
  /** How many of those are marked done. */
  doneCount: number;
}

export interface GoalStats {
  periods: number; // elapsed windows
  met: number;
  missed: number;
  hitRate: number; // 0–100
  currentStreak: number;
  bestStreak: number;
  avgMinutes: number; // mean actual over elapsed windows
  overshoots: number; // windows that went over target
  avgOvershoot: number; // mean amount over target (0 when none)
  totalMinutes: number;
}

/** A "project:ULID" / "task:ULID" / "subtask:ULID" scope ref. */
export function makeScopeRef(kind: GoalScopeKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseScopeRef(ref: string): { kind: GoalScopeKind; id: string } | null {
  const i = ref.indexOf(':');
  if (i === -1) return null;
  const kind = ref.slice(0, i) as GoalScopeKind;
  const id = ref.slice(i + 1);
  if (!GOAL_SCOPE_KINDS.includes(kind) || !id) return null;
  return { kind, id };
}

/** Parse + validate a scope array, deduping (first occurrence wins). Invalid
 *  refs are dropped — callers validate freshness/ownership separately. */
export function parseScope(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !parseScopeRef(r)) continue;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export function scopeRefs(goal: Pick<Goal, 'scope'>): { kind: GoalScopeKind; id: string }[] {
  return goal.scope.map((r) => parseScopeRef(r)!).filter(Boolean);
}

export function scopeKinds(goal: Pick<Goal, 'scope'>): { projects: string[]; tasks: string[]; subtasks: string[] } {
  const out = { projects: [], tasks: [], subtasks: [] } as Record<'projects' | 'tasks' | 'subtasks', string[]>;
  for (const r of scopeRefs(goal)) out[`${r.kind}s`].push(r.id);
  return out;
}

// ---------- period windows ----------

/** [start, end) of the civil period containing `instant`. */
export function goalPeriodBounds(
  period: GoalPeriod,
  instant: number,
  tz: string,
  weekStart: number,
): { start: number; end: number } {
  if (period === 'day') {
    const day = civilDate(instant, tz);
    const start = dayStartInstant(day, tz);
    return { start, end: dayStartInstant(addDaysCivil(day, 1), tz) };
  }
  if (period === 'week') {
    const start = weekStartInstant(instant, tz, weekStart);
    return { start, end: dayStartInstant(addDaysCivil(civilDate(start, tz), 7), tz) };
  }
  // month
  const day = civilDate(instant, tz);
  const ym = day.slice(0, 7); // YYYY-MM
  const [y, m] = ym.split('-').map(Number);
  const nextYm = m === 12 ? `${y! + 1}-01` : `${y!}-${String(m! + 1).padStart(2, '0')}`;
  return { start: dayStartInstant(`${ym}-01`, tz), end: dayStartInstant(`${nextYm}-01`, tz) };
}

const MAX_WINDOWS = 1500; // parity with REPORT_MAX_RANGE_DAYS' spirit — old daily goals can't hang the endpoint

/**
 * Enumerate a goal's period windows from creation to `now` (or expiry/archive),
 * with the target pro-rated when the goal's lifetime only partially covers a
 * window. `actual` starts at 0 — the caller fills it (server SQL; the span to
 * count is [max(start, created_at), min(end, horizon)] where horizon =
 * min(ends_at, archived_at, now)).
 */
export function goalWindows(
  goal: Pick<Goal, 'period' | 'target_minutes' | 'created_at' | 'ends_at' | 'archived_at'>,
  tz: string,
  weekStart: number,
  now: number,
): GoalWindow[] {
  // target horizon: pro-rating only cares about the goal's OWN lifetime, not
  // `now` — the current window of an active goal gets the full target
  const goalEnd = Math.min(goal.ends_at ?? Infinity, goal.archived_at ?? Infinity);
  // enumeration/actual horizon: nothing counts past the goal's end or the future
  const horizon = Math.min(goalEnd, now);
  if (horizon <= goal.created_at) return []; // expired the instant it was made (or clock skew) — no windows

  const out: GoalWindow[] = [];
  let w = goalPeriodBounds(goal.period, goal.created_at, tz, weekStart);
  while (w.start < horizon) {
    if (out.length >= MAX_WINDOWS) break;
    const covered = Math.min(goalEnd, w.end) - Math.max(goal.created_at, w.start);
    const full = w.end - w.start;
    const target =
      covered >= full ? goal.target_minutes : Math.max(1, Math.ceil((goal.target_minutes * covered) / full));
    // "over" = the window's effective span (clipped by the goal's lifetime, not
    // by `now`) is fully in the past — an active goal's current window must not
    // read as elapsed just because we clip its counted time at `now`
    const elapsed = Math.min(w.end, goalEnd) <= now;
    const current = !elapsed && w.start <= now && now < w.end;
    out.push({ start: w.start, end: w.end, target, actual: 0, elapsed, current });
    if (goal.period === 'day') {
      const day = addDaysCivil(civilDate(w.start, tz), 1);
      w = { start: dayStartInstant(day, tz), end: dayStartInstant(addDaysCivil(day, 1), tz) };
    } else if (goal.period === 'week') {
      const start = dayStartInstant(addDaysCivil(civilDate(w.start, tz), 7), tz);
      w = { start, end: dayStartInstant(addDaysCivil(civilDate(start, tz), 7), tz) };
    } else {
      w = goalPeriodBounds('month', w.end, tz, weekStart); // w.end IS the next month's first instant
    }
  }
  return out;
}

// ---------- derived status ----------

/**
 * Deactivation is derived from live data, never stored: un-checking a scope
 * item re-activates a completed goal (decision: not destructive). Order
 * matters — a goal whose scope happens to be all-done when its expiry passes
 * reads as completed, not expired.
 */
export function goalStatus(
  goal: Pick<Goal, 'ends_at' | 'archived_at' | 'direction'>,
  scope: GoalScopeState,
  now: number,
): GoalStatus {
  if (goal.archived_at !== null) return 'archived';
  if (scope.liveCount > 0 && scope.doneCount >= scope.liveCount) return 'completed';
  if (goal.ends_at !== null && goal.ends_at <= now) return 'expired';
  return 'active';
}

/** True when the scope resolved to nothing live (every ref tombstoned) — the
 *  goal can never complete and shows a "scope deleted" warning instead. */
export function scopeIsEmpty(scope: GoalScopeState): boolean {
  return scope.liveCount === 0;
}

/** Whether one tracked window meets its target, per direction. */
export function windowMet(direction: GoalDirection, actual: number, target: number): boolean {
  return direction === 'at_least' ? actual >= target : actual <= target;
}

// ---------- stats ----------

/** Aggregate stats over the ELAPSED windows (the current one is still open). */
export function goalStats(goal: Pick<Goal, 'direction'>, windows: GoalWindow[]): GoalStats {
  const done = windows.filter((w) => w.elapsed);
  const periods = done.length;
  let met = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  let run = 0;
  let total = 0;
  const overshootAmts: number[] = [];
  for (const w of done) {
    total += w.actual;
    const isMet = windowMet(goal.direction, w.actual, w.target);
    if (isMet) {
      met += 1;
      run += 1;
      bestStreak = Math.max(bestStreak, run);
      if (w.actual > w.target) overshootAmts.push(w.actual - w.target);
    } else {
      run = 0;
      if (goal.direction === 'at_most' && w.actual > w.target) overshootAmts.push(w.actual - w.target);
    }
  }
  currentStreak = run; // windows are chronological — the trailing run IS the current streak
  const missed = periods - met;
  const avg = periods ? total / periods : 0;
  return {
    periods,
    met,
    missed,
    hitRate: periods ? Math.round((met / periods) * 100) : 0,
    currentStreak,
    bestStreak,
    avgMinutes: Math.round(avg),
    overshoots: overshootAmts.length,
    avgOvershoot: overshootAmts.length
      ? Math.round(overshootAmts.reduce((a, b) => a + b, 0) / overshootAmts.length)
      : 0,
    totalMinutes: total,
  };
}

// ---------- display ----------

/** Human target phrase: "≥ 5h/week" / "< 45m/day". */
export function fmtTarget(goal: Pick<Goal, 'direction' | 'period' | 'target_minutes'>): string {
  const h = Math.floor(goal.target_minutes / 60);
  const m = goal.target_minutes % 60;
  const amount = h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
  const sign = goal.direction === 'at_least' ? '≥ ' : '< ';
  return `${sign}${amount}/${goal.period}`;
}
