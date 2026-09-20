// Pure validators (§5.5): DAG cycles, password policy, pomodoro config ranges,
// session time rules, and the import/restore row schemas (audit S3).
import { describe, it, expect } from 'vitest';
import {
  findCyclePath, passwordProblem, pomoProblem, checkSessionTimes
} from '../src/shared/validation';
import {
  sessionCreateSchema, sessionPatchSchema, restoreSchema,
  importTaskRow, importProjectRow, importSessionRow
} from '../src/worker/validators';
import { LIMITS } from '../src/shared/constants';

const NOW = 1_800_000_000_000;
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

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

describe('manual session schemas', () => {
  const base = { task_id: ULID, started_at: NOW };
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

describe('import/restore row schemas (audit S3)', () => {
  it('task rows require a ULID project reference (non-ULID ids are skipped upstream)', () => {
    expect(importTaskRow.safeParse({ id: ULID, project_id: 'not-a-ulid' }).success).toBe(false);
    expect(importTaskRow.safeParse({ id: ULID, project_id: ULID }).success).toBe(true);
  });
  it('coerces done to 0/1 and garbage positions to 0 (no NaN binds)', () => {
    const r = importTaskRow.safeParse({ id: ULID, project_id: ULID, done: true, position: 'abc' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.done).toBe(1);
    expect(r.success && r.data.position).toBe(0);
  });
  it('project rows coerce garbage created_at to 0 (clamped to now upstream)', () => {
    const r = importProjectRow.safeParse({ id: ULID, created_at: 'nope' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.created_at).toBe(0);
  });
  it('session rows allow a NULL ended_at (undo of a deleted running task) but not garbage timestamps', () => {
    const open = importSessionRow.safeParse({ id: ULID, task_id: ULID, started_at: NOW, ended_at: null });
    expect(open.success).toBe(true);
    const bad = importSessionRow.safeParse({ id: ULID, task_id: ULID, started_at: 'x', ended_at: NOW });
    expect(bad.success).toBe(false);
  });
});

describe('restore payload caps', () => {
  it('accepts an undo payload of well-formed rows at the schema caps', () => {
    const sessions = Array.from({ length: 5001 }, (_, i) => ({
      id: ULID, task_id: ULID, started_at: i, ended_at: i + 1, note: '', source: 'manual', created_at: i
    }));
    const r = restoreSchema.safeParse({ sessions });
    expect(r.success).toBe(true);
  });
  it('rejects payloads over the total-row guard', () => {
    const row = { id: ULID, task_id: ULID, name: 'x', done: 0, position: 0, created_at: 0 };
    const r = restoreSchema.safeParse({
      subtasks: Array.from({ length: LIMITS.restoreMaxRows }, () => row)
    });
    expect(r.success).toBe(false);
  });
});
