// Recency list ("Jump back in" / Resume, FR: L14): one entry per task, newest
// first, each carrying the subtask of that task's latest session. Resume must
// restore the subtask — a task-id-only list loses it.
import { describe, it, expect } from 'vitest';
import { mergeRecent, recentFromBootstrap, RECENT_LIMIT, type RecentEntry } from '../src/web/lib/recent';

const T = (task_id: string, subtask_id: string | null = null): RecentEntry => ({ task_id, subtask_id });

describe('mergeRecent', () => {
  it('moves a tracked task to the front with its new subtask', () => {
    const next = mergeRecent([T('a', 'a1'), T('b')], 'b', 'b2');
    expect(next).toEqual([T('b', 'b2'), T('a', 'a1')]);
  });

  it('keeps the previous subtask of untouched tasks, replaces the tracked task\'s', () => {
    const next = mergeRecent([T('a', 'a1'), T('b', 'b1')], 'a', null);
    expect(next).toEqual([T('a', null), T('b', 'b1')]);
  });

  it('inserts a brand-new task at the front', () => {
    const next = mergeRecent([T('a')], 'z', 'z1');
    expect(next).toEqual([T('z', 'z1'), T('a')]);
  });

  it('caps the list, evicting from the tail', () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENT_LIMIT + 2; i++) list = mergeRecent(list, `t${i}`, null);
    expect(list.length).toBe(RECENT_LIMIT);
    expect(list[0]).toEqual(T(`t${RECENT_LIMIT + 1}`));
    expect(list.map((e) => e.task_id)).not.toContain('t0');
  });

  it('normalizes undefined subtask ids to null', () => {
    expect(mergeRecent([], 'a', undefined)).toEqual([T('a')]);
  });
});

describe('recentFromBootstrap', () => {
  it('reads the subtask-aware shape', () => {
    expect(recentFromBootstrap({ recent: [{ task_id: 'a', subtask_id: 'a1' }, { task_id: 'b', subtask_id: null }] }))
      .toEqual([T('a', 'a1'), T('b')]);
  });

  it('falls back to the legacy task-id-only array', () => {
    expect(recentFromBootstrap({ recent_task_ids: ['a', 'b'] })).toEqual([T('a'), T('b')]);
  });

  it('drops malformed rows and non-string subtasks instead of crashing', () => {
    expect(recentFromBootstrap({ recent: [null, { subtask_id: 'x' }, { task_id: 'a', subtask_id: 5 }, { task_id: 'b' }] }))
      .toEqual([T('a'), T('b')]);
  });

  it('returns [] for absent/empty payloads', () => {
    expect(recentFromBootstrap({})).toEqual([]);
    expect(recentFromBootstrap({ recent: [] })).toEqual([]);
    expect(recentFromBootstrap(null)).toEqual([]);
  });
});
