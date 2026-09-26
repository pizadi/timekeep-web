// dev4: the session editor's wall-clock parsing must survive non-hour offsets,
// DST gaps (a typed time that doesn't exist) and repeated hours (fall-back) —
// and the render-time echo must not crash on an empty/malformed field.
// Regression: the old fixed-iteration guess loop drifted ~4h per step for gap
// times, saving a session hours away from what was typed.
import { describe, it, expect } from 'vitest';
import {
  toLocalInput, fromLocalInput, parseLocalInput, fmtUtcOffset, localTimeWarning
} from '../src/web/lib/time';

const TEHRAN = 'Asia/Tehran';        // +03:30, no DST since 2022
const KATHMANDU = 'Asia/Kathmandu';  // +05:45
const NEW_YORK = 'America/New_York'; // classic US transitions

describe('toLocalInput / fromLocalInput round-trips', () => {
  it('survives a 30-minute offset', () => {
    const instant = Date.UTC(2026, 8, 26, 6, 30); // 10:00 +03:30
    expect(toLocalInput(instant, TEHRAN)).toBe('2026-09-26T10:00');
    expect(fromLocalInput('2026-09-26T10:00', TEHRAN)).toBe(instant);
  });

  it('survives a 45-minute offset', () => {
    const instant = Date.UTC(2026, 8, 26, 0, 15); // 06:00 +05:45
    expect(toLocalInput(instant, KATHMANDU)).toBe('2026-09-26T06:00');
    expect(fromLocalInput('2026-09-26T06:00', KATHMANDU)).toBe(instant);
  });

  it('round-trips ordinary times across both US transition days', () => {
    for (const value of ['2026-03-08T01:30', '2026-03-08T03:30', '2026-11-01T03:30', '2026-11-01T05:00']) {
      expect(toLocalInput(fromLocalInput(value, NEW_YORK), NEW_YORK)).toBe(value);
    }
  });

  it('keeps whole-hour zones exact', () => {
    const instant = Date.UTC(2026, 8, 26, 8, 0); // 16:00 +08:00
    expect(fromLocalInput('2026-09-26T16:00', 'Asia/Singapore')).toBe(instant);
  });
});

describe('fromLocalInput at clock changes', () => {
  it('falls forward for a wall clock inside the spring-forward gap', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT: 02:30 doesn't exist → 03:30 EDT = 07:30 UTC
    expect(fromLocalInput('2026-03-08T02:30', NEW_YORK)).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it('resolves a repeated (fall-back) wall clock to its earlier occurrence', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST: 01:30 happens twice → EDT (earlier) = 05:30 UTC
    expect(fromLocalInput('2026-11-01T01:30', NEW_YORK)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('picks the single occurrence when the neighbouring offset also round-trips', () => {
    // civil 02:30 on the fall-back day exists only as EST (02:xx EDT is cut by the jump)
    expect(fromLocalInput('2026-11-01T02:30', NEW_YORK)).toBe(Date.UTC(2026, 10, 1, 7, 30));
  });
});

describe('parseLocalInput (render-time null safety)', () => {
  it('returns null for empty and malformed values instead of NaN/throwing', () => {
    expect(parseLocalInput('', TEHRAN)).toBeNull();
    expect(parseLocalInput('garbage', TEHRAN)).toBeNull();
  });

  it('parses valid values normally', () => {
    expect(parseLocalInput('2026-09-26T10:00', TEHRAN)).toBe(Date.UTC(2026, 8, 26, 6, 30));
  });
});

describe('fmtUtcOffset', () => {
  it('formats non-hour offsets with sign and minutes', () => {
    expect(fmtUtcOffset(Date.UTC(2026, 8, 26, 6, 30), TEHRAN)).toBe('UTC+03:30');
    expect(fmtUtcOffset(Date.UTC(2026, 8, 26, 0, 15), KATHMANDU)).toBe('UTC+05:45');
  });

  it('formats UTC and western offsets', () => {
    expect(fmtUtcOffset(Date.UTC(2026, 8, 26, 12, 0), 'UTC')).toBe('UTC');
    expect(fmtUtcOffset(Date.UTC(2026, 0, 15, 12, 0), NEW_YORK)).toBe('UTC−05:00'); // EST
    expect(fmtUtcOffset(Date.UTC(2026, 6, 15, 12, 0), NEW_YORK)).toBe('UTC−04:00'); // EDT
  });
});

describe('localTimeWarning', () => {
  it('is silent for ordinary times', () => {
    expect(localTimeWarning('2026-09-26T10:00', TEHRAN)).toBeNull();
    expect(localTimeWarning('2026-03-08T01:30', NEW_YORK)).toBeNull();
    expect(localTimeWarning('2026-11-01T05:00', NEW_YORK)).toBeNull();
  });

  it('warns that a gap time will be shifted', () => {
    const w = localTimeWarning('2026-03-08T02:30', NEW_YORK);
    expect(w).toContain("doesn't exist");
    expect(w).toContain('03:30');
  });

  it('warns that a repeated hour occurs twice', () => {
    const w = localTimeWarning('2026-11-01T01:30', NEW_YORK);
    expect(w).toContain('twice');
  });

  it('stays silent for empty/malformed values (echo renders while typing)', () => {
    expect(localTimeWarning('', TEHRAN)).toBeNull();
    expect(localTimeWarning('garbage', TEHRAN)).toBeNull();
  });
});
