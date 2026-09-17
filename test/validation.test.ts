// Pure validators (§5.5): session overlap, DAG cycles + edge legality,
// password policy, two-level hierarchy, pomodoro config ranges.
import { describe, it, expect } from 'vitest';
import {
  findOverlaps, findCyclePath, edgeProblem, passwordProblem, pomoProblem,
  checkSessionTimes, subtaskPositionLimitProblem
} from '../src/shared/validation';
import { sessionCreateSchema, sessionPatchSchema, restoreSchema } from '../src/worker/validators';
import { LIMITS } from '../src/shared/constants';

const NOW = 1_800_000_000_000;

describe('session overlap (FR-S4)', () => {
  const rows = [
    { id: 'a', started_at: NOW, ended_at: NOW + 3600_000 },
    { id: 'b', started_at: NOW + 7200_000, ended_at: NOW + 9000_000 }
  ];
  it('rejects overlapping same-task ranges and lists conflicts', () => {
    const hits = findOverlaps(rows, NOW + 1800_000, NOW + 7500_000, NOW);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('allows touching intervals (end == next start)', () => {
    const hits = findOverlaps(rows, NOW + 3600_000, NOW + 7200_000, NOW);
    expect(hits).toHaveLength(0);
  });
  it('treats a running session (ended_at null) as occupying until now', () => {
    const running = [{ id: 'r', started_at: NOW - 1000, ended_at: null }];
    expect(findOverlaps(running, NOW - 500, NOW + 500, NOW)).toHaveLength(1);
  });
  it('excludes the edited session itself', () => {
    const hits = findOverlaps(rows, NOW, NOW + 1800_000, NOW, 'a');
    expect(hits).toHaveLength(0);
  });
});

describe('DAG cycle prevention (FR-M4)', () => {
  const edges = [
    { task_id: 'B', depends_on_id: 'A' }, // B depends on A
    { task_id: 'C', depends_on_id: 'B' }  // C depends on B
  ];
  it('rejects an edge that closes a cycle and names the chain', () => {
    // edges: B depends_on A, C depends_on B. Adding "A depends_on C" closes A→C→B→A.
    // Reachability: A is reachable from C via depends_on (C⇒B⇒A) → chain [C, B, A].
    const path = findCyclePath(edges, 'A', 'C');
    expect(path).toEqual(['C', 'B', 'A']);
  });
  it('allows a legal new edge', () => {
    expect(findCyclePath(edges, 'D', 'A')).toBeNull(); // D depends_on A
  });
  it('flags edge legality problems (FR-M5)', () => {
    expect(edgeProblem(
      { parent_id: null, project_id: 'p1' },
      { parent_id: 't1', project_id: 'p1' }
    )).toContain('root tasks');
    expect(edgeProblem(
      { parent_id: null, project_id: 'p1' },
      { parent_id: null, project_id: 'p2' }
    )).toContain('same project');
  });
});

describe('password policy (FR-A1)', () => {
  const common = (pw: string) => ['password123', 'qwertyuiop', '1234567890'].includes(pw);
  it('requires ≥ 10 chars', () => {
    expect(passwordProblem('short1!A', common)).toContain('10');
  });
  it('rejects top-10k common passwords', () => {
    expect(passwordProblem('password123', common)).toContain('common');
  });
  it('accepts long uncommon passwords with no composition rules', () => {
    expect(passwordProblem('purple-marmalade-tuesday', common)).toBeNull();
  });
});

describe('pomodoro config (FR-F5)', () => {
  it('enforces 5–90 focus / 1–30 break', () => {
    expect(pomoProblem(4, 5)).toContain('focus');
    expect(pomoProblem(91, 5)).toContain('focus');
    expect(pomoProblem(25, 0)).toContain('break');
    expect(pomoProblem(25, 31)).toContain('break');
    expect(pomoProblem(50, 10)).toBeNull();
  });
});

describe('session time rules (§5.5.4)', () => {
  const created = NOW - 365 * 24 * 3600_000;
  it('rejects start ≥ end', () => {
    expect(checkSessionTimes(NOW, NOW, created, NOW).ok).toBe(false);
  });
  it('rejects start before account creation', () => {
    expect(checkSessionTimes(created - 1, NOW, created, NOW).ok).toBe(false);
  });
  it('rejects starts > 5 minutes in the future', () => {
    expect(checkSessionTimes(NOW + 6 * 60_000, NOW + 10 * 60_000, created, NOW).ok).toBe(false);
    expect(checkSessionTimes(NOW + 4 * 60_000, NOW + 5 * 60_000, created, NOW).ok).toBe(true);
  });
});

describe('hierarchy limits (FR-T3/FR-T7)', () => {
  it('blocks subtask creation beyond 100 per task', () => {
    expect(subtaskPositionLimitProblem(100)).toContain('100');
    expect(subtaskPositionLimitProblem(99)).toBeNull();
  });
});

describe('manual session schemas', () => {
  const base = { task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', started_at: NOW };
  it('create schema rejects open-ended (ended_at null) sessions', () => {
    const r = sessionCreateSchema.safeParse({ ...base, ended_at: null });
    expect(r.success).toBe(false);
  });
  it('create schema accepts closed intervals', () => {
    const r = sessionCreateSchema.safeParse({ ...base, ended_at: NOW + 1 });
    expect(r.success).toBe(true);
  });
  it('patch schema rejects clearing ended_at back to null', () => {
    const r = sessionPatchSchema.safeParse({ ended_at: null });
    expect(r.success).toBe(false);
  });
});

describe('restore payload caps', () => {
  const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  it('accepts an undo payload at the schema per-collection caps', () => {
    const sessions = Array.from({ length: 5001 }, (_, i) => ({ id: ULID, started_at: i }));
    const r = restoreSchema.safeParse({ sessions });
    expect(r.success).toBe(true);
  });
  it('rejects payloads over the total-row guard', () => {
    const row = { id: ULID };
    const r = restoreSchema.safeParse({
      subtasks: Array.from({ length: LIMITS.restoreMaxRows }, () => row)
    });
    expect(r.success).toBe(false);
  });});
