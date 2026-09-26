// Client-side display helpers. Bucketing decisions are the server's (NFR-6);
// the client uses the profile timezone for display and datetime-local defaults.
// fmtHMS lives once in shared/time.ts (re-exported here for convenience).
import { nowMs } from './api';
import { fmtHMS as fmtHMS_, zoneOffsetMs } from '../../shared/time';

export { fmtHMS_ as fmtHMS };

export function fmtClock(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(instant);
}

export function fmtDateTime(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(instant);
}

export function fmtDay(civil: string): string {
  const d = new Date(`${civil}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).format(d);
}

/** Value for <input type="datetime-local"> in the user's timezone, defaulting to the last hour (FR-S4). */
export function toLocalInput(instant: number, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instant));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

/**
 * Parse a datetime-local value as wall-clock time in tz → epoch ms.
 * Start from the wall clock read as UTC (next1) and correct by the offset seen
 * there:
 *  - offset unchanged → next1 is a fixed point (its wall clock IS the value);
 *  - a clock change sits between the two guesses → the same wall clock may
 *    exist under the neighbouring offset too (fall-back: it occurs twice — the
 *    earlier occurrence wins), once (taken from that side), or not at all
 *    (spring-forward gap → fall forward to just after the transition).
 * Every candidate is verified by round-trip rather than by offset-sign rules.
 * The old fixed-iteration loop had no such case analysis: for a gap time each
 * step drifted by the new offset and the result landed hours away.
 */
export function fromLocalInput(value: string, tz: string): number {
  const [datePart, timePart = '00:00'] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const o1 = guessOffset(asUtc, tz);
  const next1 = asUtc - o1;
  const o2 = guessOffset(next1, tz);
  if (o2 === o1) return next1;
  const other = asUtc - o2; // the same wall clock attempted under next1's offset
  const next1Ok = toLocalInput(next1, tz) === value;
  const otherOk = toLocalInput(other, tz) === value;
  if (next1Ok && otherOk) return Math.min(next1, other); // occurs twice → earlier
  if (otherOk) return other;
  return next1; // exists only under next1's offset, or not at all (gap → fall forward)
}

/** fromLocalInput, but null for an empty/malformed value — a datetime-local
 *  field can momentarily hold '' while being typed, and the render-time echo
 *  and warnings must not crash on NaN instants. */
export function parseLocalInput(value: string, tz: string): number | null {
  try {
    const instant = fromLocalInput(value, tz);
    return Number.isFinite(instant) ? instant : null;
  } catch { return null; }
}

function guessOffset(instant: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(instant));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - instant;
}

/** "UTC+03:30" / "UTC" / "UTC−04:30" — the zone's offset at `instant` (DST-aware). */
export function fmtUtcOffset(instant: number, tz: string): string {
  const m = Math.round(zoneOffsetMs(instant, tz) / 60000);
  if (m === 0) return 'UTC';
  const a = Math.abs(m);
  return `UTC${m > 0 ? '+' : '−'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Device's IANA zone (undefined in exotic browsers without tz data). */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch { return null; }
}

/** Warning for a datetime-local value whose wall clock doesn't exist (DST
 *  spring-forward gap) or occurs twice (fall-back) in `tz` — null when the
 *  value round-trips unambiguously. Pure display: saving stays allowed. */
export function localTimeWarning(value: string, tz: string): string | null {
  const clock = value.replace('T', ' ');
  const parsed = parseLocalInput(value, tz);
  if (parsed === null) return null;
  const roundTrip = toLocalInput(parsed, tz);
  if (roundTrip !== value) {
    return `“${clock}” doesn't exist on that date (clock change) — it will be saved as ${roundTrip.replace('T', ' ')}.`;
  }
  const hour = 3600_000;
  // a repeated hour keeps the same civil time one hour earlier or later
  const repeats = toLocalInput(parsed + hour, tz) === value || toLocalInput(parsed - hour, tz) === value;
  return repeats ? `“${clock}” happens twice on that date (clock change) — double-check the saved time.` : null;
}

/** Last N civil days (inclusive) in the user's timezone — range presets (FR-R1). */
export function rangePreset(
  preset: 'today' | 'week' | 'month' | '30d' | { from: string; to: string },
  tz: string, weekStartDow = 1
): { from: string; to: string } {
  const now = nowMs();
  const today = civilOf(now, tz);
  if (typeof preset === 'object') return preset;
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') {
    const weekStart = weekStartCivil(today, weekStartDow);
    return { from: weekStart, to: today };
  }
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 29);
  return { from: d.toISOString().slice(0, 10), to: today };
}

function weekStartCivil(today: string, weekStartDow: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun…6=Sat
  const delta = (dow - weekStartDow + 7) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

export function civilOf(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
