// Timezone correctness engine (NFR-6).
// All instants are epoch-ms UTC. Day/week bucketing happens in the user's IANA timezone
// via Intl (Workers ship full ICU). A "day" is always a civil day in the user's zone;
// sessions crossing midnight are clipped into per-day buckets (FR-R1).

const partsCache = new Map<string, Intl.DateTimeFormat>();
const validTz = new Set<string>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    partsCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  if (validTz.has(tz)) return true;
  try {
    formatter(tz);
    validTz.add(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) to add to the UTC instant to get wall-clock time in `tz` (i.e. local = utc + offset). */
export function zoneOffsetMs(instant: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(m.year), Number(m.month) - 1, Number(m.day),
    Number(m.hour) % 24, Number(m.minute), Number(m.second)
  );
  return asUTC - instant;
}

/** Wall-clock fields of an instant in `tz`. */
export function zonedParts(instant: number, tz: string) {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  return { year: m.year!, month: m.month!, day: m.day!, hour: m.hour! % 24, minute: m.minute!, second: m.second! };
}

/** Civil date (YYYY-MM-DD) of an instant in `tz`. */
export function civilDate(instant: number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Local wall-clock milliseconds since local midnight (for display). */
export function wallClockMs(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  return ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
}

/**
 * First instant of the civil day `civil` (YYYY-MM-DD) in `tz`.
 * Fast path: guess-and-correct against the zone offset. When midnight was
 * skipped by a DST transition (e.g. Asia/Tehran 2021-03-22), the iteration
 * oscillates — fall back to a binary search for the first instant whose
 * civil date equals the target (civilDate is monotonic in the instant).
 */
export function dayStartInstant(civil: string, tz: string): number {
  const [y, mo, d] = civil.split('-').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!);
  let instant = guess - zoneOffsetMs(guess, tz);
  for (let i = 0; i < 4; i++) {
    const next = guess - zoneOffsetMs(instant, tz);
    if (next === instant) {
      if (civilDate(instant, tz) === civil) return instant;
      break;
    }
    instant = next;
  }
  // slow path: skipped-midnight / ambiguous-transition days
  let lo = guess - 15 * 3600_000;
  let hi = guess + 15 * 3600_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (civilDate(mid, tz) >= civil) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function addDaysCivil(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Inclusive list of consecutive civil dates. */
export function civilRange(fromCivil: string, toCivil: string): string[] {
  const out: string[] = [];
  let cur = fromCivil;
  let guard = 0;
  while (cur <= toCivil && guard++ < 1500) {
    out.push(cur);
    cur = addDaysCivil(cur, 1);
  }
  return out;
}

/** [start, end) UTC instant bounds for each civil day in the range (per-day buckets). */
export function dayBounds(fromCivil: string, toCivil: string, tz: string): { day: string; start: number; end: number }[] {
  const days = civilRange(fromCivil, toCivil);
  return days.map((day) => {
    const start = dayStartInstant(day, tz);
    return { day, start, end: dayStartInstant(addDaysCivil(day, 1), tz) };
  });
}

/** Today's civil date in `tz` for a given instant. */
export function todayCivil(now: number, tz: string): string {
  return civilDate(now, tz);
}

/**
 * Clip a span to a bucket and return overlap in ms (0 if disjoint).
 * `endOpen` is used when the session is still running (ended_at IS NULL → now).
 */
export function overlapMs(start: number, end: number, bStart: number, bEnd: number): number {
  const s = Math.max(start, bStart);
  const e = Math.min(end, bEnd);
  return e > s ? e - s : 0;
}

export interface DayBucket { day: string; start: number; end: number; ms: number }

/**
 * Pure reference implementation of the day-bucketing contract (FR-R1 / NFR-6).
 * The server computes the same result in SQL via a json_each()-fed day table;
 * this function is the tested source of truth (see test/time.test.ts).
 */
export function bucketByDay(
  sessions: { started_at: number; ended_at: number | null }[],
  fromCivil: string, toCivil: string, tz: string, now: number
): DayBucket[] {
  const bounds = dayBounds(fromCivil, toCivil, tz);
  return bounds.map((b) => {
    let ms = 0;
    for (const s of sessions) {
      const end = s.ended_at ?? now;
      if (s.started_at < b.end && end > b.start) ms += overlapMs(s.started_at, end, b.start, b.end);
    }
    return { day: b.day, start: b.start, end: b.end, ms };
  });
}

/** Start of the user's week containing `instant`, honoring weekStart (0=Sun … 6=Sat). */
export function weekStartInstant(instant: number, tz: string, weekStart: number): number {
  const p = zonedParts(instant, tz);
  const civil = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun…6=Sat
  const delta = (dow - weekStart + 7) % 7;
  return dayStartInstant(addDaysCivil(civil, -delta), tz);
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function fmtHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
