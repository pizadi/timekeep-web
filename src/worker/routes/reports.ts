// FR-R: server-side aggregates. Buckets are computed IN SQL via a json_each()-fed
// day table (one text parameter carries all per-day boundaries, so D1's 100-param
// limit never binds); timezone correctness lives in shared/time.ts (NFR-6).
// Clients receive buckets — never raw session rows (NFR-1).
// The running session is included, clipped to `now` (FR-R6).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { requireAuth } from '../middleware';
import { dayBounds, weekStartInstant, civilDate, dayStartInstant, minutes } from '../../shared/time';

export const reportRoutes = new Hono<WorkerType>();
reportRoutes.use('*', requireAuth);

// days CTE: ?1 = [["2026-09-01", startMs, endMs], …] (one text parameter —
// D1's bound-parameter limit never binds regardless of range length).
// json_each over an array yields key=element-index, value=element-array.
const DAYS_CTE = `
  WITH days(day, start_ms, end_ms) AS (
    SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'), json_extract(je.value, '$[2]')
    FROM json_each(?1) AS je
  )`;

reportRoutes.get('/reports/summary', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const now = Date.now();
  const tz = user.timezone;
  const qFrom = c.req.query('from');
  const qTo = c.req.query('to');
  const today = civilDate(now, tz);
  const from = qFrom && /^\d{4}-\d{2}-\d{2}$/.test(qFrom) ? qFrom : today;
  const to = qTo && /^\d{4}-\d{2}-\d{2}$/.test(qTo) ? qTo : today;

  const bounds = dayBounds(from, to, tz);
  if (bounds.length === 0) return c.json({ days: [], donut: [], table: [], totals: { today: 0, week: 0, all: 0 }, server_now: now });

  const rangeStart = bounds[0]!.start;
  const rangeEnd = bounds[bounds.length - 1]!.end;
  const daysJson = JSON.stringify(bounds.map((b) => [b.day, b.start, b.end]));

  const todayStart = dayStartInstant(today, tz);
  const todayEnd = dayStartInstant(nextCivil(today), tz);
  const weekStart = weekStartInstant(now, tz, user.week_start);

  // day × project buckets (clipped at user-local midnight, running included)
  const bucketRows = await c.env.DB.prepare(
    `${DAYS_CTE}
     SELECT d.day AS day, t.project_id AS project_id,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), d.end_ms) - MAX(s.started_at, d.start_ms))) AS ms
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     JOIN days d ON s.started_at < d.end_ms AND COALESCE(s.ended_at, ?2) > d.start_ms
     WHERE s.user_id = ?3 AND s.started_at < ?4 AND COALESCE(s.ended_at, ?2) > ?5
     GROUP BY d.day, t.project_id`
  ).bind(daysJson, now, userId, rangeEnd, rangeStart).all<{ day: string; project_id: string; ms: number }>();

  // donut shares over the range (clipped to range)
  const donutRows = await c.env.DB.prepare(
    `SELECT t.project_id AS project_id,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS ms
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     WHERE s.user_id = ?4 AND s.started_at < ?2 AND COALESCE(s.ended_at, ?1) > ?3
     GROUP BY t.project_id`
  ).bind(now, rangeEnd, rangeStart, userId).all<{ project_id: string; ms: number }>();

  // summary table: today / week / all-time columns (desktop-parity totals map, FR-R4)
  const tableRows = await c.env.DB.prepare(
    `SELECT t.id AS task_id, t.name AS task_name, t.done, t.project_id AS project_id,
            p.name AS project_name, p.color AS project_color,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS today_ms,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?4) - MAX(s.started_at, ?5))) AS week_ms,
            SUM(COALESCE(s.ended_at, ?1) - s.started_at) AS all_ms
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE s.user_id = ?6
     GROUP BY t.id`
  ).bind(now, todayEnd, todayStart, now, weekStart, userId).all<any>();

  const totals = {
    today: minutes(tableRows.results.reduce((a, r) => a + Number(r.today_ms ?? 0), 0)),
    week: minutes(tableRows.results.reduce((a, r) => a + Number(r.week_ms ?? 0), 0)),
    all: minutes(tableRows.results.reduce((a, r) => a + Number(r.all_ms ?? 0), 0))
  };

  return c.json({
    from, to, timezone: tz,
    days: bucketRows.results.map((r) => ({ day: r.day, project_id: r.project_id, minutes: minutes(Number(r.ms)) })),
    donut: donutRows.results.map((r) => ({ project_id: r.project_id, minutes: minutes(Number(r.ms)) })),
    table: tableRows.results.map((r) => ({
      task_id: r.task_id, task_name: r.task_name, done: !!r.done,
      project_id: r.project_id, project_name: r.project_name, project_color: r.project_color,
      today: minutes(Number(r.today_ms ?? 0)), week: minutes(Number(r.week_ms ?? 0)), all: minutes(Number(r.all_ms ?? 0))
    })),
    totals,
    server_now: now
  });
});

reportRoutes.get('/reports/heatmap', async (c) => {
  const userId = c.get('user').id;
  const user = c.get('user');
  const now = Date.now();
  const year = Number(c.req.query('year') ?? civilDate(now, user.timezone).slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 2200)
    return new Response(JSON.stringify({ error: { code: 'validation', message: 'invalid year' } }), { status: 422 });

  const tz = user.timezone;
  const bounds = dayBounds(`${year}-01-01`, `${year}-12-31`, tz);
  const daysJson = JSON.stringify(bounds.map((b) => [b.day, b.start, b.end]));

  const rows = await c.env.DB.prepare(
    `${DAYS_CTE}
     SELECT d.day AS day, SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), d.end_ms) - MAX(s.started_at, d.start_ms))) AS ms
     FROM time_sessions s
     JOIN days d ON s.started_at < d.end_ms AND COALESCE(s.ended_at, ?2) > d.start_ms
     WHERE s.user_id = ?3
     GROUP BY d.day`
  ).bind(daysJson, now, userId).all<{ day: string; ms: number }>();

  return c.json({
    year,
    days: rows.results.map((r) => ({ day: r.day, minutes: minutes(Number(r.ms)) })),
    server_now: now
  });
});

function nextCivil(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
