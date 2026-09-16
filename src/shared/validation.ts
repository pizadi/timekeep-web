// Pure validation rules shared by server (authoritative) and tests.
// SQL is the execution layer; these functions are the spec'd contracts (§5.5).

import { LIMITS, POMODORO_LIMITS, SESSION_RULES, HEX_COLOR_RE } from './constants';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export function passwordProblem(pw: string, isCommon: (pw: string) => boolean): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'password must be at least 10 characters';
  if (pw.length > 200) return 'password too long';
  if (isCommon(pw.toLowerCase())) return 'password is too common — choose something less guessable';
  return null;
}

export function nameProblem(name: string, max = LIMITS.nameMax): string | null {
  const n = name.trim();
  if (n.length === 0) return 'name must not be empty';
  if (n.length > max) return `name must be at most ${max} characters`;
  return null;
}

export function colorProblem(color: string): string | null {
  return HEX_COLOR_RE.test(color) ? null : 'color must be a #rrggbb hex value';
}

export function noteProblem(note: string): string | null {
  return note.length <= LIMITS.noteMax ? null : `note must be at most ${LIMITS.noteMax} characters`;
}

export function pomoProblem(focusMin: number, breakMin: number): string | null {
  if (!Number.isInteger(focusMin) || focusMin < POMODORO_LIMITS.focusMinMin || focusMin > POMODORO_LIMITS.focusMinMax)
    return `focus must be ${POMODORO_LIMITS.focusMinMin}–${POMODORO_LIMITS.focusMinMax} minutes`;
  if (!Number.isInteger(breakMin) || breakMin < POMODORO_LIMITS.breakMinMin || breakMin > POMODORO_LIMITS.breakMinMax)
    return `break must be ${POMODORO_LIMITS.breakMinMin}–${POMODORO_LIMITS.breakMinMax} minutes`;
  return null;
}

export interface SessionTimeCheck {
  ok: boolean;
  problem?: string;
}

/**
 * Session time validation (§5.5.4):
 *  - started_at < ended_at
 *  - started_at ≥ account created_at
 *  - started_at ≤ now + 5 min (both endpoints)
 */
export function checkSessionTimes(
  startedAt: number, endedAt: number | null, accountCreatedAt: number, now: number
): SessionTimeCheck {
  if (!Number.isFinite(startedAt) || (endedAt !== null && !Number.isFinite(endedAt)))
    return { ok: false, problem: 'invalid timestamps' };
  if (endedAt !== null && startedAt >= endedAt) return { ok: false, problem: 'start must be before end' };
  if (startedAt < accountCreatedAt) return { ok: false, problem: 'start is before the account existed' };
  const maxFuture = now + SESSION_RULES.futureToleranceMs;
  if (startedAt > maxFuture) return { ok: false, problem: 'start is more than 5 minutes in the future' };
  if (endedAt !== null && endedAt > maxFuture) return { ok: false, problem: 'end is more than 5 minutes in the future' };
  return { ok: true };
}

export interface IntervalRow { id: string; started_at: number; ended_at: number | null }

/**
 * Same-task overlap detection (FR-S4): cross-task overlap is allowed — real life is messy.
 * A running session (ended_at NULL) occupies until `now`.
 */
export function findOverlaps(
  rows: IntervalRow[], start: number, end: number, now: number, excludeId?: string
): IntervalRow[] {
  return rows.filter((r) => {
    if (excludeId && r.id === excludeId) return false;
    const otherEnd = r.ended_at ?? now;
    return r.started_at < end && otherEnd > start;
  });
}

/** DAG edge legality pre-checks before the SQL reachability query (§5.5.2). */
export function edgeProblem(a: { parent_id: string | null; project_id: string }, b: { parent_id: string | null; project_id: string }): string | null {
  if (a.parent_id !== null || b.parent_id !== null) return 'dependencies may only connect root tasks';
  if (a.project_id !== b.project_id) return 'dependencies may only connect tasks of the same project';
  return null;
}

/**
 * Cycle detection over an in-memory edge list — mirrors the server's recursive CTE
 * (WITH REACH …) and builds the offending cycle path for the error toast (FR-M4).
 * Edge semantics: task depends_on target ("A depends on B" ⇒ B is the prerequisite).
 * Adding A depends_on B is illegal when A is reachable from B via depends_on edges.
 * Returns the path [target, …, source] (the existing chain that would be closed).
 */
export function findCyclePath(edges: { task_id: string; depends_on_id: string }[], source: string, target: string): string[] | null {
  // BFS from target following depends_on edges; if we reach source → cycle.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.task_id) ?? [];
    list.push(e.depends_on_id);
    adj.set(e.task_id, list);
  }
  const prev = new Map<string, string>([[target, '']]);
  const queue = [target];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === source) {
      // reconstruct path target → … → source
      const path: string[] = [];
      let node: string | undefined = source;
      while (node && node !== '') { path.unshift(node); node = prev.get(node); }
      return path; // [target, …, source]
    }
    for (const next of adj.get(cur) ?? []) {
      if (!prev.has(next)) { prev.set(next, cur); queue.push(next); }
    }
  }
  return null;
}

export function subtaskPositionLimitProblem(count: number): string | null {
  return count >= LIMITS.subtasksPerTask ? `a task can have at most ${LIMITS.subtasksPerTask} subtasks` : null;
}

export function limitProblem(count: number, limit: number, what: string): string | null {
  return count >= limit ? `limit reached: at most ${limit} ${what} per account` : null;
}
