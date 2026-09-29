// Pure goal-math contract (shared/goals.ts) — the tested source of truth for
// period windows, pro-rating, derived status and stats.
import { describe, expect, it } from 'vitest';
import {
  fmtTarget,
  goalPeriodBounds,
  goalStats,
  goalStatus,
  goalWindows,
  parseScope,
  parseScopeRef,
  windowMet,
  type Goal,
} from '../src/shared/goals';

const TZ = 'UTC';
const MON = Date.parse('2026-01-05T00:00:00Z'); // a Monday
const DAY = 86_400_000;

function mkGoal(p: Partial<Goal> = {}): Goal {
  return {
    id: '01ABC',
    user_id: 'u1',
    name: '',
    period: 'week',
    direction: 'at_least',
    target_minutes: 600, // 10h
    scope: ['project:P1'],
    ends_at: null,
    created_at: MON,
    archived_at: null,
    ...p,
  };
}

describe('scope refs', () => {
  it('parses kind:id refs and rejects garbage', () => {
    expect(parseScopeRef('project:01ABC')).toEqual({ kind: 'project', id: '01ABC' });
    expect(parseScopeRef('subtask:01ABC')).toEqual({ kind: 'subtask', id: '01ABC' });
    expect(parseScopeRef('nope:01ABC')).toBeNull();
    expect(parseScopeRef('task:')).toBeNull();
    expect(parseScopeRef('plainstring')).toBeNull();
  });

  it('dedupes and drops invalid entries, keeping order', () => {
    expect(parseScope(['task:A', 'task:A', 'bogus', 'project:B', 42 as unknown as string])).toEqual([
      'task:A',
      'project:B',
    ]);
    expect(parseScope('not an array')).toEqual([]);
  });
});

describe('goalPeriodBounds', () => {
  it('bounds the civil day containing an instant', () => {
    const b = goalPeriodBounds('day', MON + 5 * 3600_000, TZ, 1);
    expect(b.start).toBe(MON);
    expect(b.end).toBe(MON + DAY);
  });

  it('bounds the week honoring week_start (Monday here, Sunday there)', () => {
    const wed = MON + 2 * DAY; // Wednesday of MON's week
    expect(goalPeriodBounds('week', wed, TZ, 1).start).toBe(MON);
    // Sunday start: Wednesday's week opens on Sunday Jan 4
    expect(goalPeriodBounds('week', wed, TZ, 0).start).toBe(Date.parse('2026-01-04T00:00:00Z'));
  });

  it('bounds the calendar month (including year rollover)', () => {
    const b = goalPeriodBounds('month', Date.parse('2026-12-15T10:00:00Z'), TZ, 1);
    expect(b.start).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(b.end).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('handles DST-length days via the shared engine (23h/25h days)', () => {
    // America/New_York spring-forward: Mar 8 2026 is a 23h day
    const before = goalPeriodBounds('day', Date.parse('2026-03-08T12:00:00Z'), 'America/New_York', 1);
    expect(before.end - before.start).toBe(23 * 3600_000);
  });
});

describe('goalWindows', () => {
  it('emits full-target windows for a lifetime goal, marking the current one', () => {
    const g = mkGoal({ created_at: MON });
    const now = MON + 15 * DAY; // two full weeks + 1 day into the third
    const ws = goalWindows(g, TZ, 1, now);
    expect(ws).toHaveLength(3);
    expect(ws[0]).toMatchObject({ target: 600, elapsed: true, current: false });
    expect(ws[2]).toMatchObject({ target: 600, elapsed: false, current: true });
    expect(ws[2].start).toBe(MON + 14 * DAY);
  });

  it('pro-rates the first window when created mid-period', () => {
    const g = mkGoal({ created_at: MON + 3 * DAY }); // Thursday → 4 of 7 days left
    const ws = goalWindows(g, TZ, 1, MON + 4 * DAY);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.target).toBe(Math.ceil((600 * 4) / 7));
    expect(ws[0]!.current).toBe(true);
  });

  it('pro-rates the final window cut short by expiry (the 4/7 case)', () => {
    const g = mkGoal({ created_at: MON, ends_at: MON + 4 * DAY }); // ends Friday 00:00
    const now = MON + 10 * DAY;
    const ws = goalWindows(g, TZ, 1, now);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.target).toBe(Math.ceil((600 * 4) / 7));
    expect(ws[0]!.elapsed).toBe(true); // expiry already passed
    expect(ws.some((w) => w.current)).toBe(false);
  });

  it('never counts time past expiry, even mid-window', () => {
    const g = mkGoal({ created_at: MON, ends_at: MON + 4 * DAY });
    const ws = goalWindows(g, TZ, 1, MON + 4 * DAY);
    // the SQL span the caller is told to count ends at the horizon
    expect(ws[0]!.elapsed).toBe(true);
  });

  it('freezes the timeline at archived_at', () => {
    const g = mkGoal({ created_at: MON, archived_at: MON + 3 * DAY });
    const ws = goalWindows(g, TZ, 1, MON + 30 * DAY);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.target).toBe(Math.ceil((600 * 3) / 7));
  });

  it('returns no windows when the horizon is at/before creation', () => {
    expect(goalWindows(mkGoal({ ends_at: MON }), TZ, 1, MON + DAY)).toEqual([]);
    expect(goalWindows(mkGoal({ ends_at: MON }), TZ, 1, MON)).toEqual([]);
  });

  it('enumerates month windows across year boundaries', () => {
    const g = mkGoal({ period: 'month', created_at: Date.parse('2025-11-20T00:00:00Z') });
    const ws = goalWindows(g, TZ, 1, Date.parse('2026-01-10T00:00:00Z'));
    expect(ws).toHaveLength(3);
    expect(ws[0]!.target).toBe(Math.ceil((600 * 11) / 30)); // Nov 20–30: 11 of 30 days
    expect(ws[2]!.current).toBe(true);
  });
});

describe('goalStatus', () => {
  const now = MON + 10 * DAY;
  it('archived wins over everything', () => {
    expect(goalStatus(mkGoal({ archived_at: now }), { liveCount: 2, doneCount: 0 }, now)).toBe('archived');
  });
  it('completed wins over expired (all scope done)', () => {
    expect(goalStatus(mkGoal({ ends_at: now - DAY }), { liveCount: 2, doneCount: 2 }, now)).toBe('completed');
  });
  it('expired when the end passed and scope is not all done', () => {
    expect(goalStatus(mkGoal({ ends_at: now - DAY }), { liveCount: 2, doneCount: 1 }, now)).toBe('expired');
  });
  it('active otherwise', () => {
    expect(goalStatus(mkGoal(), { liveCount: 2, doneCount: 1 }, now)).toBe('active');
  });
  it('an empty (fully tombstoned) scope can never complete', () => {
    expect(goalStatus(mkGoal(), { liveCount: 0, doneCount: 0 }, now)).toBe('active');
  });
});

describe('windowMet', () => {
  it('at_least meets at/above the target, at_most at/below', () => {
    expect(windowMet('at_least', 600, 600)).toBe(true);
    expect(windowMet('at_least', 599, 600)).toBe(false);
    expect(windowMet('at_most', 600, 600)).toBe(true);
    expect(windowMet('at_most', 601, 600)).toBe(false);
    expect(windowMet('at_most', 0, 600)).toBe(true); // tracking nothing satisfies a limit
  });
});

describe('goalStats', () => {
  it('computes streaks, hit rate and overshoots for at_least goals', () => {
    const mk = (actual: number, elapsed = true) => ({ actual, target: 600, elapsed, current: false, start: 0, end: 0 });
    const s = goalStats({ direction: 'at_least' }, [mk(300), mk(700), mk(650), mk(700), mk(0, false)]);
    expect(s.periods).toBe(4);
    expect(s.met).toBe(3);
    expect(s.missed).toBe(1);
    expect(s.hitRate).toBe(75);
    expect(s.currentStreak).toBe(3); // trailing 700, 650, 700
    expect(s.bestStreak).toBe(3);
    expect(s.overshoots).toBe(3); // every met window beat the target
    expect(s.avgOvershoot).toBe(Math.round((100 + 50 + 100) / 3));
    expect(s.totalMinutes).toBe(300 + 700 + 650 + 700);
  });

  it('counts only exceeding windows as overshoots for at_most goals', () => {
    const mk = (actual: number, target = 600, elapsed = true) => ({
      actual,
      target,
      elapsed,
      current: false,
      start: 0,
      end: 0,
    });
    const s = goalStats({ direction: 'at_most' }, [mk(300), mk(700), mk(0), mk(800, 600, false)]);
    expect(s.met).toBe(2); // 300 and 0 stayed under; the 700 blew it
    expect(s.overshoots).toBe(1);
    expect(s.avgOvershoot).toBe(100);
  });

  it('is all zeros with no elapsed windows', () => {
    const s = goalStats({ direction: 'at_least' }, [
      { actual: 0, target: 600, elapsed: false, current: true, start: 0, end: 0 },
    ]);
    expect(s.periods).toBe(0);
    expect(s.hitRate).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(0);
  });
});

describe('fmtTarget', () => {
  it('renders the human target phrase per direction and period', () => {
    expect(fmtTarget(mkGoal({ target_minutes: 600 }))).toBe('≥ 10h/week');
    expect(fmtTarget(mkGoal({ direction: 'at_most', target_minutes: 45, period: 'day' }))).toBe('< 45m/day');
    expect(fmtTarget(mkGoal({ target_minutes: 90, period: 'month' }))).toBe('≥ 1h 30m/month');
  });
});
