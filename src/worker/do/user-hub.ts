// UserHub Durable Object — one instance per user (§5.7).
// Owns: (a) N WebSockets (hibernation API), (b) the active-timer + pomodoro state
// machine in memory, (c) D1 persistence of transitions in ordered batches,
// (d) sync_log appends + WS fan-out, (e) Alarms as failsafes (pomodoro deadlines,
// >12h running nudge — never auto-stops, FR §5.7).
//
// Ticks are NEVER persisted per second (NFR-2): the DO recomputes elapsed time
// from `started_at`; a 24h timer writes ~2 rows, not 86,400.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { ulid } from '../../shared/ids';
import { WsEvent } from '../../shared/constants';
import { DEFAULT_SETTINGS } from '../defaults';

type PomoPhase = 'idle' | 'focus' | 'decide' | 'break' | 'ready';

interface PomoState {
  phase: PomoPhase;
  taskId: string | null;        // task the cycle was started on
  accumulatedFocusMs: number;   // tracked-only focus time (FR-F1)
  lastResumeMs: number | null;  // instant the currently-running focus segment began
  breakEndsAt: number | null;   // wall-clock break deadline (FR-F3)
}

interface RunningSession {
  id: string;
  task_id: string;
  started_at: number;
  source: 'timer' | 'pomodoro';
}

const TWELVE_H = 12 * 3600_000;

export class UserHub extends DurableObject {
  declare env: Env;
  private loaded = false;
  private running: RunningSession | null = null;
  private pomo: PomoState = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
  private settings = { focusMs: 25 * 60_000, breakMs: 5 * 60_000, autoStart: false };
  private lastEventId = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
  }

  // ---------- storage helpers (DO-private SQL kv for pomodoro state) ----------

  private kvGet(key: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?1', key).toArray();
    return rows[0]?.v ?? null;
  }

  private kvSet(key: string, v: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, v
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
    );
    // settings (durations live server-side, FR-F5/F-C1)
    const row = await this.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
      .bind(this.ctx.id.toString()).first<{ data: string }>().catch(() => null);
    try {
      const s = JSON.parse(row?.data ?? '{}') ?? {};
      const f = Number(s?.pomodoro?.focus_min ?? DEFAULT_SETTINGS.pomodoro.focus_min);
      const b = Number(s?.pomodoro?.break_min ?? DEFAULT_SETTINGS.pomodoro.break_min);
      this.settings = {
        focusMs: clamp(f, 5, 90) * 60_000,
        breakMs: clamp(b, 1, 30) * 60_000,
        autoStart: !!s?.pomodoro?.auto_start
      };
    } catch { /* defaults */ }

    // running session from the D1 recovery mirror (FR-S3)
    const at = await this.env.DB.prepare(
      `SELECT at.session_id, at.task_id, at.started_at, s.source
       FROM active_timers at JOIN time_sessions s ON s.id = at.session_id
       WHERE at.user_id = ?1`
    ).bind(this.userId()).first<any>().catch(() => null);
    if (at) {
      this.running = { id: at.session_id, task_id: at.task_id, started_at: Number(at.started_at), source: at.source ?? 'timer' };
    } else {
      this.running = null;
    }

    // pomodoro state from DO storage
    const raw = this.kvGet('pomo');
    if (raw) {
      try { this.pomo = { ...this.pomo, ...JSON.parse(raw) }; } catch { /* keep defaults */ }
    }
    // focus accumulation only while a tracked session actually runs (FR-F1);
    // after rehydration we resume counting from now (sub-second precision loss tolerated)
    if (this.pomo.phase === 'focus' && this.running) this.pomo.lastResumeMs = Date.now();

    const maxId = await this.env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sync_log WHERE user_id = ?1')
      .bind(this.userId()).first<{ m: number }>().catch(() => null);
    this.lastEventId = Number(maxId?.m ?? 0);

    this.loaded = true;
    await this.rearmAlarm();
  }

  private userId(): string {
    // DO instances are keyed by idFromName(userId); the name round-trips through the id.
    return this.ctx.id.name ?? this.env.USER_HUB.idFromName(this.ctx.id.toString()).toString();
  }

  // ---------- fetch router ----------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (url.pathname === '/ws' && request.headers.get('upgrade') === 'websocket') {
      return this.handleUpgrade(request);
    }
    if (url.pathname === '/state') {
      return Response.json(this.stateSnapshot());
    }
    if (url.pathname === '/revoke') {
      // sessions were revoked (deactivation / password reset) — drop live sockets
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4001, 'session revoked'); } catch { /* already closing */ }
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/notify') {
      const body = await request.json<{ events: WsEvent[] }>().catch(() => null);
      if (body?.events?.length) {
        for (const e of body.events) this.lastEventId = Math.max(this.lastEventId, e.id);
        this.broadcastMany(body.events);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/timer') {
      const body = await request.json<{ op: 'start' | 'stop' | 'switch'; task_id?: string; device: string }>().catch(() => null);
      if (!body) return this.err(422, 'validation', 'invalid body');
      if (body.op === 'start') return this.timerStart(body.task_id!, body.device, 'timer');
      if (body.op === 'stop') return this.timerStop(body.device);
      if (body.op === 'switch') return this.timerSwitch(body.task_id!, body.device);
      return this.err(422, 'validation', 'unknown op');
    }
    if (url.pathname === '/pomo') {
      const body = await request.json<{ op: 'start' | 'start_break' | 'skip'; task_id?: string; device: string }>().catch(() => null);
      if (!body) return this.err(422, 'validation', 'invalid body');
      if (body.op === 'start') return this.pomoStart(body.task_id, body.device);
      if (body.op === 'start_break') return this.pomoBreak(body.device);
      if (body.op === 'skip') return this.pomoSkip(body.device);
      return this.err(422, 'validation', 'unknown op');
    }
    return this.err(404, 'not_found', 'unknown DO route');
  }

  // ---------- websocket (FR-N1) ----------

  private handleUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const device = url.searchParams.get('device') ?? 'unknown';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [device]);
    const hello: WsEvent = {
      id: this.lastEventId, type: 'hello', actor: 'server', at: Date.now(),
      data: {
        running: this.running, pomo: this.visiblePomo(),
        devices: this.ctx.getWebSockets().length,
        server_now: Date.now()
      }
    };
    pair[1].send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    if (typeof message === 'string' && message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    }
  }

  override async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // no-op: hibernation handles cleanup; presence count refreshes on next hello
  }

  // ---------- snapshots ----------

  private stateSnapshot() {
    return {
      session: this.running,
      pomo: this.visiblePomo(),
      last_event_id: this.lastEventId,
      devices: this.ctx.getWebSockets().length,
      server_now: Date.now()
    };
  }

  /** Client-facing pomo view: includes live focus accumulation (no ticking rows — NFR-2). */
  private visiblePomo() {
    const now = Date.now();
    const focusLive = this.pomo.phase === 'focus' && this.running && this.pomo.lastResumeMs
      ? this.pomo.accumulatedFocusMs + (now - this.pomo.lastResumeMs)
      : this.pomo.accumulatedFocusMs;
    return {
      ...this.pomo,
      focus_ms_live: Math.max(0, focusLive),
      focus_goal_ms: this.settings.focusMs,
      break_ms_total: this.settings.breakMs,
      break_ms_left: this.pomo.phase === 'break' && this.pomo.breakEndsAt
        ? Math.max(0, this.pomo.breakEndsAt - now) : null,
      server_now: now
    };
  }

  // ---------- timer authority (FR-S1) ----------

  private async timerStart(taskId: string, device: string, source: 'timer' | 'pomodoro'): Promise<Response> {
    if (this.running) {
      return this.err(409, 'already_running', 'a timer is already running — use switch', { running: this.running });
    }
    const task = await this.env.DB.prepare(
      `SELECT t.id, p.archived FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?1 AND t.user_id = ?2`
    ).bind(taskId, this.userId()).first<any>();
    if (!task) return this.err(404, 'not_found', 'task not found');
    if (task.archived) return this.err(422, 'archived', 'this project is archived — new timers are blocked on it');

    const now = Date.now();
    const sessionId = ulid(now);
    this.running = { id: sessionId, task_id: taskId, started_at: now, source };
    const ev = { type: 'timer.started', actor: device, data: { session: this.running, task_id: taskId } };

    // single ordered batch: session row + recovery mirror + sync_log (NFR-5: no partial writes)
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, '', ?4, ?4)`
      ).bind(sessionId, this.userId(), taskId, now, source),
      this.env.DB.prepare(
        `INSERT INTO active_timers (user_id, task_id, session_id, started_at, pomo_state)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id) DO UPDATE SET task_id = excluded.task_id,
           session_id = excluded.session_id, started_at = excluded.started_at, pomo_state = excluded.pomo_state`
      ).bind(this.userId(), taskId, sessionId, now, JSON.stringify(this.pomo)),
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
    ]);
    const eventId = Number(results[2]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);
    this.broadcast({ id: eventId, type: 'timer.started', actor: device, at: now, data: ev.data });

    // pomodoro: resuming/starting focus accumulation with a live timer (FR-F1)
    if (this.pomo.phase === 'focus') {
      this.pomo.lastResumeMs = now;
      if (this.pomo.taskId === null) this.pomo.taskId = taskId;
      await this.persistPomo();
      await this.rearmAlarm();
    }
    return Response.json({ session: this.running, events: [{ id: eventId, type: 'timer.started', actor: device, at: now, data: ev.data }] });
  }

  private async timerStop(device: string): Promise<Response> {
    if (!this.running) return this.err(409, 'not_running', 'no timer is running');
    const now = Date.now();
    const session = { ...this.running, ended_at: now };
    const ev = { type: 'timer.stopped', actor: device, data: { session } };

    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE time_sessions SET ended_at = ?1, updated_at = ?1 WHERE id = ?2'
      ).bind(now, session.id),
      this.env.DB.prepare('DELETE FROM active_timers WHERE user_id = ?1').bind(this.userId()),
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
    ]);
    const eventId = Number(results[2]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);

    // focus freezes when tracking stops (FR-F1) — no phase change
    if (this.pomo.phase === 'focus' && this.pomo.lastResumeMs) {
      this.pomo.accumulatedFocusMs += now - this.pomo.lastResumeMs;
      this.pomo.lastResumeMs = null;
      await this.persistPomo();
    }
    this.running = null;
    await this.rearmAlarm();
    this.broadcast({ id: eventId, type: 'timer.stopped', actor: device, at: now, data: ev.data });
    return Response.json({ session, events: [{ id: eventId, type: 'timer.stopped', actor: device, at: now, data: ev.data }] });
  }

  /** Atomic stop-old + start-new — one call, one event, zero overlap/gap (FR-S1 AC). */
  private async timerSwitch(taskId: string, device: string): Promise<Response> {
    if (!this.running) {
      // tolerate: treat as start
      return this.timerStart(taskId, device, 'timer');
    }
    const task = await this.env.DB.prepare(
      `SELECT t.id, p.archived FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?1 AND t.user_id = ?2`
    ).bind(taskId, this.userId()).first<any>();
    if (!task) return this.err(404, 'not_found', 'task not found');
    if (task.archived) return this.err(422, 'archived', 'this project is archived — new timers are blocked on it');
    if (task.id === this.running.task_id) {
      return Response.json({ session: this.running, events: [] });
    }

    const now = Date.now();
    const stopped = { ...this.running, ended_at: now };
    const newId = ulid(now + 1);
    const started: RunningSession = { id: newId, task_id: taskId, started_at: now + 1, source: 'timer' };
    const ev = { type: 'timer.switched', actor: device, data: { stopped, started } };

    const results = await this.env.DB.batch([
      this.env.DB.prepare('UPDATE time_sessions SET ended_at = ?1, updated_at = ?1 WHERE id = ?2')
        .bind(now, stopped.id),
      this.env.DB.prepare(
        `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'timer', '', ?4, ?4)`
      ).bind(newId, this.userId(), taskId, now + 1),
      this.env.DB.prepare(
        `UPDATE active_timers SET task_id = ?2, session_id = ?3, started_at = ?4, pomo_state = ?5 WHERE user_id = ?1`
      ).bind(this.userId(), taskId, newId, now + 1, JSON.stringify(this.pomo)),
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
    ]);
    const eventId = Number(results[3]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);
    this.running = started;
    await this.rearmAlarm();
    this.broadcast({ id: eventId, type: 'timer.switched', actor: device, at: now, data: ev.data });
    return Response.json({ stopped, started, events: [{ id: eventId, type: 'timer.switched', actor: device, at: now, data: ev.data }] });
  }

  // ---------- pomodoro state machine (FR-F1–F5) ----------

  private async pomoStart(taskId: string | undefined, device: string): Promise<Response> {
    if (this.pomo.phase === 'break') {
      // starting focus during a break cancels the break (FR-F3)
      this.pomo = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
    }
    if (this.pomo.phase === 'idle' || this.pomo.phase === 'ready' || this.pomo.phase === 'decide') {
      this.pomo = { phase: 'focus', taskId: taskId ?? this.running?.task_id ?? null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
    }
    await this.persistPomo();
    // start the timer if none runs (FR-F1) — one explicit action
    if (!this.running) {
      const target = taskId ?? this.pomo.taskId;
      if (!target) return this.err(422, 'no_task', 'pick a task to start the pomodoro on');
      const timerRes = await this.timerStart(target, device, 'pomodoro');
      if (timerRes.status !== 200) return timerRes;
      // respond with the pomodoro envelope (the timer event already fanned out)
      return this.pomoPhaseResponse(device, 'focus');
    }
    if (this.pomo.phase === 'focus') {
      this.pomo.lastResumeMs = Date.now();
      await this.persistPomo();
    }
    await this.rearmAlarm();
    return this.pomoPhaseResponse(device, 'focus');
  }

  /** Decide prompt's "Start break". Stops tracking first so no break time is ever logged (FR-F3). */
  private async pomoBreak(device: string): Promise<Response> {
    if (this.running) await this.timerStop(device);
    const now = Date.now();
    this.pomo.phase = 'break';
    this.pomo.breakEndsAt = now + this.settings.breakMs;
    this.pomo.accumulatedFocusMs = 0;
    this.pomo.lastResumeMs = null;
    await this.persistPomo();
    await this.rearmAlarm();
    return this.pomoPhaseResponse(device, 'break');
  }

  /** Skippable from any non-idle phase; resets to idle, discards progress, logs nothing (FR-F4). */
  private async pomoSkip(device: string): Promise<Response> {
    if (this.pomo.phase === 'idle') return Response.json({ pomo: this.visiblePomo() });
    this.pomo = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
    await this.persistPomo();
    await this.rearmAlarm();
    return this.pomoPhaseResponse(device, 'idle');
  }

  private async pomoPhaseResponse(device: string, phase: PomoPhase): Promise<Response> {
    const now = Date.now();
    const ev: WsEvent = { id: 0, type: 'pomodoro.phase', actor: device, at: now, data: { pomo: this.visiblePomo() } };
    const results = await this.env.DB.batch([
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: device, data: ev.data }), now)
    ]);
    ev.id = Number(results[0]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, ev.id);
    this.broadcast(ev);
    return Response.json({ pomo: this.visiblePomo(), events: [ev] });
  }

  private async persistPomo(): Promise<void> {
    this.kvSet('pomo', JSON.stringify(this.pomo));
    if (this.running) {
      await this.env.DB.prepare(
        'UPDATE active_timers SET pomo_state = ?1 WHERE user_id = ?2'
      ).bind(JSON.stringify(this.pomo), this.userId()).run().catch(() => {});
    }
  }

  // ---------- alarms (e) ----------

  private async rearmAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    if (this.pomo.phase === 'break' && this.pomo.breakEndsAt) deadlines.push(this.pomo.breakEndsAt);
    if (this.pomo.phase === 'focus' && this.running) {
      const live = this.pomo.accumulatedFocusMs + (this.pomo.lastResumeMs ? now - this.pomo.lastResumeMs : 0);
      if (live < this.settings.focusMs) deadlines.push(now + (this.settings.focusMs - live));
    }
    if (this.running) deadlines.push(this.running.started_at + TWELVE_H);
    if (deadlines.length === 0) return;
    const next = Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - next) > 1000) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    const fired: WsEvent[] = [];

    // 12h running failsafe — nudge only, never auto-stop (§5.7)
    if (this.running && now >= this.running.started_at + TWELVE_H) {
      fired.push({ id: 0, type: 'timer.nudge', actor: 'server', at: now, data: { running_since: this.running.started_at } });
      await this.logAndBroadcast(fired[fired.length - 1]!);
    }

    // focus goal reached → decide (a prompt, not a timed phase; never stops the timer, FR-F2)
    if (this.pomo.phase === 'focus' && this.running) {
      const live = this.pomo.accumulatedFocusMs + (this.pomo.lastResumeMs ? now - this.pomo.lastResumeMs : 0);
      if (live >= this.settings.focusMs) {
        this.pomo.phase = 'decide';
        this.pomo.accumulatedFocusMs = Math.max(this.pomo.accumulatedFocusMs, this.settings.focusMs);
        await this.persistPomo();
        await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: now, data: { pomo: this.visiblePomo() } });
      }
    }

    // break end → ready nudge; optional auto-start (explicit consent by configuration, FR-F5)
    if (this.pomo.phase === 'break' && this.pomo.breakEndsAt && now >= this.pomo.breakEndsAt) {
      this.pomo.phase = 'ready';
      this.pomo.breakEndsAt = null;
      await this.persistPomo();
      await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: now, data: { pomo: this.visiblePomo() } });
      if (this.settings.autoStart && this.pomo.taskId) {
        const target = this.pomo.taskId;
        this.pomo = { phase: 'focus', taskId: target, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
        if (!this.running) await this.timerStart(target, 'server', 'pomodoro');
        await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: now, data: { pomo: this.visiblePomo() } });
      }
    }

    await this.rearmAlarm();
  }

  private async logAndBroadcast(ev: WsEvent): Promise<void> {
    const results = await this.env.DB.batch([
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), ev.at)
    ]);
    ev.id = Number(results[0]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, ev.id);
    this.broadcast(ev);
  }

  // ---------- fan-out ----------

  private broadcast(ev: WsEvent): void {
    const msg = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* hibernation will reap dead sockets */ }
    }
  }

  private broadcastMany(events: WsEvent[]): void {
    for (const e of events) this.broadcast(e);
  }

  private err(status: number, code: string, message: string, details?: unknown): Response {
    return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
