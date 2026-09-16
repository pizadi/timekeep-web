// NFR-6 acceptance fixtures: identical UTC sessions bucketed around DST
// transitions for Asia/Tehran (DST-abolishing oddity) and America/New_York
// (spring-forward), plus midnight clipping (FR-R1 AC).
import { describe, it, expect } from 'vitest';
import {
  dayStartInstant, bucketByDay, civilDate, weekStartInstant, zoneOffsetMs, dayBounds
} from '../src/shared/time';

const TEHRAN = 'Asia/Tehran';
const NEW_YORK = 'America/New_York';

function mins(ms: number) { return Math.round(ms / 60000); }

describe('timezone engine (NFR-6)', () => {
  it('computes local midnight instants for Tehran', () => {
    // Tehran abolished DST in 2022; 2026-03-21 is a plain day (UTC+3:30)
    const start = dayStartInstant('2026-03-21', TEHRAN);
    expect(civilDate(start, TEHRAN)).toBe('2026-03-21');
    expect(mins(zoneOffsetMs(start, TEHRAN))).toBe(210);
  });

  it('handles Tehran historical DST (2021 spring forward +1h at 00:00)', () => {
    // In 2021 Tehran jumped from +3:30 to +4:30 at 2021-03-22 00:00 local.
    // 2021-03-21 local offset is +3:30; 2021-03-23 is +4:30.
    expect(mins(zoneOffsetMs(dayStartInstant('2021-03-21', TEHRAN), TEHRAN))).toBe(210);
    expect(mins(zoneOffsetMs(dayStartInstant('2021-03-23', TEHRAN), TEHRAN))).toBe(270);
  });

  it('handles US spring-forward (2026-03-08, America/New_York)', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT; that civil day has 23 hours.
    const b = dayBounds('2026-03-08', '2026-03-08', NEW_YORK);
    expect(b).toHaveLength(1);
    const hours = mins(b[0]!.end - b[0]!.start) / 60;
    expect(hours).toBe(23);
  });

  it('handles US fall-back (2026-11-01, America/New_York) — 25-hour day', () => {
    const b = dayBounds('2026-11-01', '2026-11-01', NEW_YORK);
    expect(mins(b[0]!.end - b[0]!.start) / 60).toBe(25);
  });

  it('produces identical per-day totals for identical UTC sessions in Tehran around a transition', () => {
    // Sessions straddling local midnight across the 2021 Tehran spring-forward.
    const day = dayStartInstant('2021-03-22', TEHRAN);
    const next = dayStartInstant('2021-03-23', TEHRAN);
    const sessions = [
      { started_at: day - 30 * 60_000, ended_at: day + 15 * 60_000 }, // 30 min yesterday, 15 today
      { started_at: next - 60_000, ended_at: next + 60_000 }          // 1 min each side
    ];
    const buckets = bucketByDay(sessions, '2021-03-21', '2021-03-23', TEHRAN, Date.now());
    expect(buckets).toHaveLength(3);
    expect(mins(buckets[0]!.ms)).toBe(30);
    // 15 min from session 1 + 1 min from session 2 (both in the 23-hour transition day)
    expect(mins(buckets[1]!.ms)).toBe(16);
    expect(mins(buckets[2]!.ms)).toBe(1);
  });

  it('clips a session crossing user-local midnight into two buckets (FR-R1 AC)', () => {
    // 23:30–00:15 local → 30 min on day 1 + 15 min on day 2 (NY, non-DST day)
    const d1 = dayStartInstant('2026-10-01', NEW_YORK);
    const start = d1 + 23.5 * 3600_000;
    const end = start + 45 * 60_000;
    const buckets = bucketByDay([{ started_at: start, ended_at: end }], '2026-10-01', '2026-10-02', NEW_YORK, end + 1000);
    expect(mins(buckets[0]!.ms)).toBe(30);
    expect(mins(buckets[1]!.ms)).toBe(15);
  });

  it('re-buckets when the profile timezone changes without data migration (FR-A7 AC)', () => {
    // One UTC session 2026-06-01 01:00–02:00Z: Tehran (local 04:30–05:30) → Jun 1; LA (Jun 0? 18:00–19:00) → May 31
    const s = { started_at: Date.UTC(2026, 5, 1, 1, 0), ended_at: Date.UTC(2026, 5, 1, 2, 0) };
    expect(civilDate(s.started_at, TEHRAN)).toBe('2026-06-01');
    expect(civilDate(s.started_at, 'America/Los_Angeles')).toBe('2026-05-31');
  });

  it('honors week_start for the week boundary (FR-A7)', () => {
    // 2026-09-16 is a Wednesday. Week start dow → week's first day:
    // 0=Sun→13th, 1=Mon→14th, 2=Tue→15th, 3=Wed→16th, 4=Thu→10th, 5=Fri→11th, 6=Sat→12th
    const wed = dayStartInstant('2026-09-16', 'UTC');
    const expected = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-10', '2026-09-11', '2026-09-12'];
    for (let ws = 0; ws <= 6; ws++) {
      expect(civilDate(weekStartInstant(wed, 'UTC', ws), 'UTC')).toBe(expected[ws]);
    }
  });

  it('includes a running session clipped to now', () => {
    const d1 = dayStartInstant('2026-10-01', 'UTC');
    const now = d1 + 2 * 3600_000;
    const buckets = bucketByDay(
      [{ started_at: d1 + 3600_000, ended_at: null }],
      '2026-10-01', '2026-10-01', 'UTC', now
    );
    expect(mins(buckets[0]!.ms)).toBe(60);
  });
});
