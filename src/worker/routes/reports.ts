// FR-R: server-side aggregates. Buckets are computed IN SQL via a json_each()-fed
// day table (one text parameter carries all per-day boundaries, so D1's 100-param
// limit never binds); timezone correctness lives in shared/time.ts (NFR-6).
// Clients receive buckets — never raw session rows (NFR-1).
// The running session is included, clipped to `now` (FR-R6).
import { Hono } from 'hono';
import type { WorkerType } from '../env';
import { jsonError } from '../env';
import { requireAuth, limitHeavy } from '../middleware';
import { dayBounds, weekStartInstant, civilDate, dayStartInstant, minutes } from '../../shared/time';
import { REPORT_MAX_RANGE_DAYS } from '../../shared/constants';

export const reportRoutes = new Hono<WorkerType>();
reportRoutes.use('/reports', requireAuth);
reportRoutes.use('/reports/*', requireAuth);

// days CTE: ?1 = [["2026-09-01", startMs, endMs], …] (one text parameter —
// D1's bound-parameter limit never binds regardless of range length).
// json_each over an array yields key=element-index, value=element-array.
const DAYS_CTE = `
  WITH days(day, start_ms, end_ms) AS (
    SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'), json_extract(je.value, '$[2]')
    FROM json_each(?1) AS je
  )`;

reportRoutes.get('/reports/summary', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
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
  if (bounds.length === 0) return c.json({ days: [], donut: [], donut_subtasks: [], table: [], totals: { today: 0, week: 0, all: 0 }, server_now: now });
  // audit: civilRange silently truncated at its internal guard — a 5-year range
  // returned the first ~4 years with no indication. Reject oversized ranges instead.
  if (bounds.length > REPORT_MAX_RANGE_DAYS)
    return jsonError(422, 'range_too_large', `report range is limited to ${REPORT_MAX_RANGE_DAYS} days`);

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

  // donut breakdown by subtask over the range: sessions attributed to a subtask
  // are their own slice; sessions without one stay a task-level slice (the
  // slices remain a disjoint partition of the range total — no double counting)
  const donutSubRows = await c.env.DB.prepare(
    `SELECT t.project_id AS project_id, t.id AS task_id, t.name AS task_name,
            sb.id AS subtask_id, sb.name AS subtask_name,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS ms
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     LEFT JOIN subtasks sb ON sb.id = s.subtask_id
     WHERE s.user_id = ?4 AND s.started_at < ?2 AND COALESCE(s.ended_at, ?1) > ?3
     GROUP BY t.id, sb.id
     ORDER BY t.project_id, t.name, sb.name`
  ).bind(now, rangeEnd, rangeStart, userId).all<any>();

  // summary table: today / week / all-time columns (desktop-parity totals map, FR-R4)
  // grouped by task × subtask — each task row carries its subtask breakdown
  // (sessions without a subtask attribute to the task row itself, so task
  // totals are identical to the pre-subtask behavior)
  const tableRows = await c.env.DB.prepare(
    `SELECT t.id AS task_id, t.name AS task_name, t.done, t.project_id AS project_id,
            p.name AS project_name, p.color AS project_color,
            sb.id AS subtask_id, sb.name AS subtask_name, sb.done AS subtask_done,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS today_ms,
            SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?4) - MAX(s.started_at, ?5))) AS week_ms,
            SUM(COALESCE(s.ended_at, ?1) - s.started_at) AS all_ms
     FROM time_sessions s
     JOIN tasks t ON t.id = s.task_id
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN subtasks sb ON sb.id = s.subtask_id
     WHERE s.user_id = ?6
     GROUP BY t.id, sb.id`
  ).bind(now, todayEnd, todayStart, now, weekStart, userId).all<any>();

  const table = tableRows.results.reduce<any[]>((acc, r) => {
    let row = acc.find((x) => x.task_id === r.task_id);
    if (!row) {
      row = {
        task_id: r.task_id, task_name: r.task_name, done: !!r.done,
        project_id: r.project_id, project_name: r.project_name, project_color: r.project_color,
        today: 0, week: 0, all: 0, subtasks: []
      };
      acc.push(row);
    }
    const mins = { today: minutes(Number(r.today_ms ?? 0)), week: minutes(Number(r.week_ms ?? 0)), all: minutes(Number(r.all_ms ?? 0)) };
    row.today += mins.today; row.week += mins.week; row.all += mins.all;
    if (r.subtask_id) {
      row.subtasks.push({
        subtask_id: r.subtask_id, name: r.subtask_name, done: !!r.subtask_done,
        today: mins.today, week: mins.week, all: mins.all
      });
    }
    return acc;
  }, []);

  const totals = {
    today: minutes(table.reduce((a, r) => a + r.today, 0)),
    week: minutes(table.reduce((a, r) => a + r.week, 0)),
    all: minutes(table.reduce((a, r) => a + r.all, 0))
  };

  return c.json({
    from, to, timezone: tz,
    days: bucketRows.results.map((r) => ({ day: r.day, project_id: r.project_id, minutes: minutes(Number(r.ms)) })),
    donut: donutRows.results.map((r) => ({ project_id: r.project_id, minutes: minutes(Number(r.ms)) })),
    donut_subtasks: donutSubRows.results.map((r) => ({
      project_id: r.project_id, task_id: r.task_id, task_name: r.task_name,
      subtask_id: r.subtask_id ?? null, subtask_name: r.subtask_name ?? null,
      minutes: minutes(Number(r.ms))
    })),
    table,
    totals,
    server_now: now
  });
});

// ---------- daily summary (per-day drill-down: totals, per-project, per-task/subtask) ----------

reportRoutes.get('/reports/day', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const user = c.get('user');
  const now = Date.now();
  const tz = user.timezone;
  const qDate = c.req.query('date');
  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : civilDate(now, tz);

  const [b] = dayBounds(date, date, tz);
  if (!b) return c.json({ day: date, timezone: tz, total_minutes: 0, projects: [], tasks: [], server_now: now });

  const daysJson = JSON.stringify([[b.day, b.start, b.end]]);
  const range = 's.started_at < ?2 AND COALESCE(s.ended_at, ?1) > ?3';

  const [projRows, taskRows] = await Promise.all([
    c.env.DB.prepare(
      `${DAYS_CTE}
       SELECT t.project_id AS project_id,
              SUM(MAX(0, MIN(COALESCE(s.ended_at, ?2), d.end_ms) - MAX(s.started_at, d.start_ms))) AS ms
       FROM time_sessions s
       JOIN tasks t ON t.id = s.task_id
       JOIN days d ON s.started_at < d.end_ms AND COALESCE(s.ended_at, ?2) > d.start_ms
       WHERE s.user_id = ?3
       GROUP BY t.project_id`
    ).bind(daysJson, now, userId).all<{ project_id: string; ms: number }>(),
    c.env.DB.prepare(
      `SELECT t.id AS task_id, t.name AS task_name, t.done, t.project_id AS project_id,
              p.name AS project_name, p.color AS project_color,
              sb.id AS subtask_id, sb.name AS subtask_name, sb.done AS subtask_done,
              SUM(MAX(0, MIN(COALESCE(s.ended_at, ?1), ?2) - MAX(s.started_at, ?3))) AS ms,
              MAX(s.started_at) AS last_start
       FROM time_sessions s
       JOIN tasks t ON t.id = s.task_id
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN subtasks sb ON sb.id = s.subtask_id
       WHERE s.user_id = ?4 AND ${range}
       GROUP BY t.id, sb.id
       ORDER BY last_start DESC`
    ).bind(now, b.end, b.start, userId).all<any>()
  ]);

  // fold the (task × subtask) rows into per-task rows with a subtask breakdown
  const tasks: any[] = [];
  for (const r of taskRows.results) {
    const mins = minutes(Number(r.ms ?? 0));
    let row = tasks.find((x) => x.task_id === r.task_id);
    if (!row) {
      row = {
        task_id: r.task_id, task_name: r.task_name, done: !!r.done,
        project_id: r.project_id, project_name: r.project_name, project_color: r.project_color,
        minutes: 0, total_minutes: 0, subtasks: []
      };
      tasks.push(row);
    }
    row.total_minutes += mins;
    if (r.subtask_id) {
      row.subtasks.push({ subtask_id: r.subtask_id, name: r.subtask_name, done: !!r.subtask_done, minutes: mins });
    } else {
      row.minutes += mins; // sessions not attributed to a subtask stay on the task row
    }
  }

  const projects = projRows.results.map((r) => ({ project_id: r.project_id, minutes: minutes(Number(r.ms)) }));
  return c.json({
    day: date, timezone: tz,
    total_minutes: projects.reduce((a, p) => a + p.minutes, 0),
    projects,
    tasks,
    server_now: now
  });
});

reportRoutes.get('/reports/heatmap', async (c) => {
  const limited = await limitHeavy(c);
  if (limited) return limited;
  const userId = c.get('user').id;
  const user = c.get('user');
  const now = Date.now();
  const year = Number(c.req.query('year') ?? civilDate(now, user.timezone).slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 2200)
    return jsonError(422, 'validation', 'invalid year');

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
