// Calendar heatmap (FR-R3): month-grid per-day totals — GitHub-style, week-start
// honored via server bucketing; click a day to open that day's sessions in the log.
import { useMemo, useState } from 'react';
import { store } from '../lib/store';
import { fmtDay } from '../lib/time';
import { useIsTouch } from '../lib/responsive';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // indexed by getDay()

export default function Heatmap({
  days,
  year,
  timezone,
  weekStart = 1,
}: {
  days: { day: string; minutes: number }[];
  year: number;
  timezone: string;
  weekStart?: number; // 0=Sun … 6=Sat
}) {
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of days) m.set(d.day, d.minutes);
    return m;
  }, [days]);

  const max = Math.max(1, ...days.map((d) => d.minutes));
  const [hover, setHover] = useState<string | null>(null);
  const touch = useIsTouch(); // hover captions never fire on a finger — the copy says "tap"

  // one column per ISO week; rows = weekdays starting at `weekStart`
  const weeks = useMemo(() => {
    const out: (string | null)[][] = [];
    let week: (string | null)[] = [];
    const start = new Date(`${year}-01-01T12:00:00Z`);
    const jsDow = start.getUTCDay(); // 0=Sun…6=Sat
    const lead = (jsDow - weekStart + 7) % 7;
    for (let i = 0; i < lead; i++) week.push(null);
    for (let d = new Date(start); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
      const civil = d.toISOString().slice(0, 10);
      week.push(civil);
      if (week.length === 7) {
        out.push(week);
        week = [];
      }
    }
    if (week.length) {
      while (week.length < 7) week.push(null);
      out.push(week);
    }
    return out;
  }, [year, weekStart]);

  const intensity = (mins: number): string => {
    if (mins <= 0) return 'var(--heat-0)';
    const f = Math.min(1, Math.pow(mins / max, 0.6));
    return `color-mix(in srgb, var(--heat-max) ${Math.round(18 + f * 82)}%, var(--heat-0))`;
  };

  return (
    <div style={{ display: 'inline-block' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {/* one label per grid row — .heatmap flows one column per ISO week */}
        <div aria-hidden style={{ display: 'grid', gridTemplateRows: 'repeat(7, 13px)', gap: 3 }}>
          {DOW.map((_, i) => (
            <div key={i} className="dow">
              {DOW[(weekStart + i) % 7]}
            </div>
          ))}
        </div>
        <div className="heatmap" role="img" aria-label={`Tracked minutes per day for ${year}`}>
          {weeks.map((week, wi) =>
            week.map((civil, di) =>
              civil === null ? (
                <div key={`${wi}-${di}`} className="cell" style={{ visibility: 'hidden' }} />
              ) : (
                <div
                  key={civil}
                  className="cell"
                  role="button"
                  tabIndex={0}
                  aria-label={`${fmtDay(civil)} — ${byDay.get(civil) ?? 0} min; inspect sessions`}
                  title={`${fmtDay(civil)} — ${byDay.get(civil) ?? 0} min`}
                  style={{ background: intensity(byDay.get(civil) ?? 0) }}
                  onMouseEnter={() => setHover(civil)}
                  onMouseLeave={() => setHover(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      store.navigateToView('log'); // URL sync (audit: setView desynced the URL)
                      window.dispatchEvent(new CustomEvent('tk:focus-day', { detail: civil }));
                    }
                  }}
                  onClick={() => {
                    store.navigateToView('log'); // URL sync (audit: setView desynced the URL)
                    window.dispatchEvent(new CustomEvent('tk:focus-day', { detail: civil }));
                  }}
                />
              ),
            ),
          )}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {hover
          ? `${fmtDay(hover)} · ${byDay.get(hover) ?? 0} min (times shown in ${timezone})`
          : `${touch ? 'Tap' : 'Click'} a day to inspect its sessions`}
      </div>
    </div>
  );
}
