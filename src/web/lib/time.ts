// Client-side display helpers. Bucketing decisions are the server's (NFR-6);
// the client uses the profile timezone for display and datetime-local defaults.
import { api, nowMs } from './api';
import { store } from './store';

export function fmtHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

/** Parse a datetime-local value as wall-clock time in tz → epoch ms (guess-and-correct). */
export function fromLocalInput(value: string, tz: string): number {
  const [datePart, timePart = '00:00'] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 3; i++) {
    const offset = guessOffset(guess, tz);
    const next = guess - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function guessOffset(instant: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(instant));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - instant;
}

export function runningElapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
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

export async function refreshReportData<T>(path: string): Promise<T> {
  return api<T>(path);
}

export const tzOf = () => store.get().user?.timezone ?? 'UTC';
