// Dashboard (FR-R1–R8): stacked daily bars, project donut, calendar heatmap,
// summary table — server-side aggregates, live-updated on events (FR-R5),
// running session included and growing locally (FR-R6).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import { api, nowMs } from '../lib/api';
import { rangePreset, fmtDay } from '../lib/time';
import { Chart, registerables } from 'chart.js';
import Heatmap from '../components/Heatmap';
import Dropdown from '../components/Dropdown';

Chart.register(...registerables);

type Summary = {
  from: string; to: string; days: { day: string; project_id: string; minutes: number }[];
  donut: { project_id: string; minutes: number }[];
  table: { task_id: string; task_name: string; done: boolean; project_id: string; project_name: string; project_color: string; today: number; week: number; all: number }[];
  totals: { today: number; week: number; all: number };
  server_now: number;
};

const PRESETS = ['today', 'week', 'month', '30d', 'custom'] as const;
type Preset = (typeof PRESETS)[number];

export default function DashboardView() {
  const projects = useStore((s) => s.projects);
  const user = useStore((s) => s.user)!;
  const reportsVersion = useStore((s) => s.reportsVersion);
  const running = useStore((s) => s.running);
  const [preset, setPreset] = useState<Preset>(() => (localStorage.getItem('tk.range') as Preset) || '30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [heatmapYear, setHeatmapYear] = useState(() => new Date().getFullYear());
  const [heatmap, setHeatmap] = useState<{ days: { day: string; minutes: number }[] } | null>(null);
  const [sortKey, setSortKey] = useState<'name' | 'today' | 'week' | 'all'>('all');
  const barRef = useRef<HTMLCanvasElement>(null);
  const donutRef = useRef<HTMLCanvasElement>(null);
  const charts = useRef<{ bar?: Chart; donut?: Chart }>({});

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) return { from: customFrom, to: customTo };
    // shared preset logic (lib/time); incomplete custom ranges fall back to
    // the 30-day window
    return rangePreset(preset === 'custom' ? '30d' : preset, user.timezone, user.week_start);
  }, [preset, customFrom, customTo, user.timezone, user.week_start]);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api<Summary>(`/reports/summary?from=${range.from}&to=${range.to}`),
        api<{ days: { day: string; minutes: number }[] }>(`/reports/heatmap?year=${heatmapYear}`)
      ]);
      setSummary(s);
      setHeatmap(h);
    } catch (e: any) { pushToast('error', e.message); }
  }, [range.from, range.to, heatmapYear]);

  // refetch only the affected aggregates when relevant events land (FR-R5)
  useEffect(() => { void load(); }, [load, reportsVersion]);

  useEffect(() => { localStorage.setItem('tk.range', preset); }, [preset]); // FR-R7

  const colorOf = useCallback(
    (pid: string) => projects.find((p) => p.id === pid)?.color ?? '#888',
    [projects]
  );
  const nameOf = useCallback(
    (pid: string) => projects.find((p) => p.id === pid)?.name ?? 'Unknown',
    [projects]
  );

  // charts render (theme-aware; re-render on data or theme change)
  const themeTick = useStore((s) => s.settings?.theme);
  const themePref = typeof themeTick === 'string' ? themeTick : 'system';
  useEffect(() => {
    if (!summary) return;
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim() || '#888';
    const text = css.getPropertyValue('--muted').trim() || '#888';

    // days × projects matrix
    const dayList = [...new Set(summary.days.map((d) => d.day))].sort();
    const projIds = [...new Set(summary.days.map((d) => d.project_id))];
    const datasets = projIds.map((pid) => ({
      label: nameOf(pid),
      backgroundColor: colorOf(pid),
      data: dayList.map((day) =>
        summary.days.filter((d) => d.day === day && d.project_id === pid).reduce((a, d) => a + d.minutes, 0))
    }));
    charts.current.bar?.destroy();
    if (barRef.current) {
      charts.current.bar = new Chart(barRef.current, {
        type: 'bar',
        data: { labels: dayList.map(fmtDay), datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { stacked: true, grid: { color: grid }, ticks: { color: text } },
            y: { stacked: true, grid: { color: grid }, ticks: { color: text }, title: { display: true, text: 'minutes', color: text } }
          },
          plugins: { legend: { labels: { color: text } } }
        }
      });
    }

    charts.current.donut?.destroy();
    if (donutRef.current) {
      charts.current.donut = new Chart(donutRef.current, {
        type: 'doughnut',
        data: {
          labels: summary.donut.map((d) => nameOf(d.project_id)),
          datasets: [{
            data: summary.donut.map((d) => d.minutes),
            backgroundColor: summary.donut.map((d) => colorOf(d.project_id))
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: { legend: { position: 'right', labels: { color: text } } }
        }
      });
    }
    return () => { charts.current.bar?.destroy(); charts.current.donut?.destroy(); };
  }, [summary, colorOf, nameOf, themePref]);

  // Running session grows the "today" numbers locally (FR-R6, ≥ every 30 s + on
  // stop). The server aggregates already include the running session clipped to
  // the fetch instant (summary.server_now) — so only the *tail* since the fetch
  // may be added; adding the full elapsed would double-count the session.
  const [boostTick, setBoostTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setBoostTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, [running]);

  const runningBoost = useMemo(() => {
    if (!running || !summary) return 0;
    void boostTick; // recompute on the 30 s tick (FR-R6 "≥ every 30 s")
    const fetchedAt = summary.server_now ?? nowMs();
    const now = nowMs();
    const tail = running.started_at >= fetchedAt
      ? now - running.started_at          // started after the fetch: not counted at all yet
      : Math.max(0, now - fetchedAt);     // counted up to the fetch: add the tail only
    return Math.round(tail / 60000);
  }, [running, summary, boostTick]);

  const tableSorted = useMemo(() => {
    if (!summary) return [];
    const rows = [...summary.table];
    rows.sort((a, b) => sortKey === 'name'
      ? a.task_name.localeCompare(b.task_name)
      : (b[sortKey === 'today' ? 'today' : sortKey === 'week' ? 'week' : 'all'] - a[sortKey === 'today' ? 'today' : sortKey === 'week' ? 'week' : 'all']));
    return rows;
  }, [summary, sortKey]);

  const totalRange = (summary?.donut ?? []).reduce((a, d) => a + d.minutes, 0);

  return (
    <div>
      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Range</span>
          <Dropdown ariaLabel="Report range" value={preset} onChange={(v) => setPreset(v as Preset)}
            options={[
              { value: 'today', label: 'Today', icon: '📅' },
              { value: 'week', label: 'This week', icon: '🗓' },
              { value: 'month', label: 'This month', icon: '📆' },
              { value: '30d', label: 'Last 30 days', icon: '📈' },
              { value: 'custom', label: 'Custom', icon: '✎' }
            ]} />
        </label>
        {preset === 'custom' && (
          <>
            <label className="field" style={{ marginBottom: 0 }}><span>From</span>
              <input className="input" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></label>
            <label className="field" style={{ marginBottom: 0 }}><span>To</span>
              <input className="input" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></label>
          </>
        )}
        <div className="spacer" />
        <div className="muted" style={{ fontSize: 13 }}>
          Today <b>{(summary?.totals.today ?? 0) + (running ? runningBoost : 0)}m</b> · This week <b>{summary?.totals.week ?? 0}m</b> · All time <b>{summary?.totals.all ?? 0}m</b>
        </div>
      </div>

      <div className="grid-2 charts-scroll">
        <div className="card">
          <h3>Daily minutes by project</h3>
          <div className="chart-box"><canvas ref={barRef} aria-label="Stacked daily bar chart" role="img" /></div>
        </div>
        <div className="card">
          <h3>Project share{totalRange ? ` — ${Math.floor(totalRange / 60)}h ${totalRange % 60}m` : ''}</h3>
          <div className="chart-box"><canvas ref={donutRef} aria-label="Project donut chart" role="img" /></div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <h3 style={{ flex: 1, marginBottom: 0 }}>Calendar heatmap</h3>
          <button className="btn small" onClick={() => setHeatmapYear((y) => y - 1)} aria-label="Previous year">‹ {heatmapYear - 1}</button>
          <b>{heatmapYear}</b>
          <button className="btn small" onClick={() => setHeatmapYear((y) => y + 1)} aria-label="Next year">{heatmapYear + 1} ›</button>
        </div>
        <div className="heatmap-scroll" style={{ marginTop: 10 }}>
          <Heatmap days={heatmap?.days ?? []} year={heatmapYear} timezone={user.timezone} weekStart={user.week_start} />
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px 0' }}>
          <h3 style={{ flex: 1 }}>Per-task totals</h3>
          <label className="muted" style={{ fontSize: 12.5 }}>
            Sort by{' '}
            <Dropdown style={{ width: 150, display: 'inline-flex', verticalAlign: 'middle' }} ariaLabel="Sort table" value={sortKey}
              onChange={(v) => setSortKey(v as any)}
              options={[
                { value: 'name', label: 'Name', icon: '🔤' },
                { value: 'today', label: 'Today', icon: '☀️' },
                { value: 'week', label: 'Week', icon: '📅' },
                { value: 'all', label: 'All time', icon: '∑' }
              ]} />
          </label>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Project</th><th>Task</th><th className="num">Today</th><th className="num">Week</th><th className="num">All time</th></tr>
          </thead>
          <tbody>
            {tableSorted.map((r) => (
              <tr key={r.task_id}>
                <td><span className="chip" style={{ background: r.project_color, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />{r.project_name}</td>
                <td className={r.done ? 'done-text' : ''}>{r.task_name}</td>
                <td className="num">{r.today}{running?.task_id === r.task_id ? <b style={{ color: 'var(--danger)' }}> +{runningBoost}</b> : ''}</td>
                <td className="num">{r.week}</td>
                <td className="num">{r.all}</td>
              </tr>
            ))}
            {tableSorted.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tracked time yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
