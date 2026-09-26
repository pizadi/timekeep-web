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
import { broadcastFriendPresence } from '../social';

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
  subtask_id: string | null;
  started_at: number;
  source: 'timer' | 'pomodoro';
}

const TWELVE_H = 12 * 3600_000;

export class UserHub extends DurableObject {
  declare env: Env;
  private loaded = false;
  private running: RunningSession | null = null;
  private pomo: PomoState = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
  private settings = { pomoEnabled: false, focusMs: 25 * 60_000, breakMs: 5 * 60_000, autoStart: false };
  private lastEventId = 0;
  private rl = new Map<string, number>(); // rate-limit counters (window key → hits)
  /** Next 12h-nudge deadline once the first has fired — the nudge repeats hourly
   *  while the timer runs past 12h instead of every alarm tick (audit: the old
   *  rearm-always-past-deadline behavior looped D1 writes until the timer
   *  stopped). In-memory only: a DO restart re-arms from started_at, costing at
   *  most one extra nudge. */
  private nudgeNextAt: number | null = null;

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
    // settings (durations live server-side, FR-F5/F-C1), keyed by the real user id
    const row = await this.env.DB.prepare('SELECT data FROM settings WHERE user_id = ?1')
      .bind(this.userId()).first<{ data: string }>().catch(() => null);
    try {
      const s = JSON.parse(row?.data ?? '{}') ?? {};
      this.applySettings(s);
    } catch { /* defaults */ }

    // running session from the D1 recovery mirror (FR-S3)
    this.running = await this.loadRunningFromD1();

    // pomodoro state from DO storage
    const raw = this.kvGet('pomo');
    if (raw) {
      try { this.pomo = { ...this.pomo, ...JSON.parse(raw) }; } catch { /* keep defaults */ }
    }
    // Focus accumulation across eviction: `accumulatedFocusMs` (completed
    // segments) and `lastResumeMs` (start of the in-flight segment) are both
    // persisted, so the live total recomputes exactly — the wall clock keeps
    // running while the DO is evicted; resetting lastResumeMs here would
    // discard the entire in-flight segment.
    if (this.pomo.phase === 'focus' && this.running && this.pomo.lastResumeMs == null) {
      this.pomo.lastResumeMs = Date.now(); // legacy/anomalous state only
      await this.persistPomo();
    }

    const maxId = await this.env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sync_log WHERE user_id = ?1')
      .bind(this.userId()).first<{ m: number }>().catch(() => null);
    this.lastEventId = Number(maxId?.m ?? 0);

    this.loaded = true;
    await this.rearmAlarm();
  }

  private userId(): string {
    // DO instances are keyed by idFromName(userId); the name round-trips through the id.
    // There is no correct way to recover the name from the raw id — fail loudly
    // rather than silently operating on the wrong user.
    const name = this.ctx.id.name;
    if (!name) throw new Error('UserHub must be constructed via idFromName(userId)');
    return name;
  }

  /** Merge persisted settings JSON into the live durations (clamped). */
  private applySettings(raw: unknown): void {
    const s = (raw ?? {}) as { pomodoro?: { enabled?: boolean; focus_min?: number; break_min?: number; auto_start?: boolean } };
    const f = Number(s.pomodoro?.focus_min ?? this.settings.focusMs / 60_000);
    const b = Number(s.pomodoro?.break_min ?? this.settings.breakMs / 60_000);
    this.settings = {
      pomoEnabled: !!s.pomodoro?.enabled,
      focusMs: clamp(f, 5, 90) * 60_000,
      breakMs: clamp(b, 1, 30) * 60_000,
      autoStart: !!s.pomodoro?.auto_start
    };
  }

  private async loadRunningFromD1(): Promise<RunningSession | null> {
    const at = await this.env.DB.prepare(
      `SELECT at.session_id, at.task_id, at.started_at, at.subtask_id, s.source
       FROM active_timers at JOIN time_sessions s ON s.id = at.session_id
       WHERE at.user_id = ?1`
    ).bind(this.userId()).first<{ session_id: string; task_id: string; started_at: number; subtask_id: string | null; source: 'timer' | 'pomodoro' | null }>().catch(() => null);
    if (!at) return null;
    return { id: at.session_id, task_id: at.task_id, subtask_id: at.subtask_id ?? null, started_at: Number(at.started_at), source: at.source ?? 'timer' };
  }

  // ---------- fetch router ----------

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    // Only this Worker may drive the DO (audit S5: the x-internal header used to
    // be sent and never checked — cargo cult). /ws passes it through from index.ts.
    if (request.headers.get('x-internal') !== '1')
      return this.err(403, 'forbidden', 'internal only');

    if (url.pathname === '/ws' && request.headers.get('upgrade') === 'websocket') {
      return this.handleUpgrade(request);
    }
    if (url.pathname === '/state') {
      return Response.json(this.stateSnapshot());
    }
    if (url.pathname === '/revoke') {
      // Sessions were revoked — drop the live sockets that belonged to them.
      // Sockets are tagged with their auth-session id at upgrade time, so the
      // close can be selective (audit S1: password change / revoke-others keep
      // the acting device's session alive, and its socket with it).
      const keep = url.searchParams.get('keep');
      const only = url.searchParams.get('only');
      const victims: WebSocket[] = only
        ? this.ctx.getWebSockets(only)
        : [...this.ctx.getWebSockets()].filter((ws) => !(keep && this.ctx.getWebSockets(keep).includes(ws)));
      for (const ws of victims) {
        try { ws.close(4001, 'session revoked'); } catch { /* already closing */ }
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/notify') {
      const body = await request.json<{ events: WsEvent[] }>().catch(() => null);
      if (body?.events?.length) {
        let runningCleared = false;
        let pomoCancelled = false;
        for (const e of body.events) {
          this.lastEventId = Math.max(this.lastEventId, e.id);
          if (e.type === 'settings.updated') {
            this.applySettings((e.data as any)?.settings);
            // pomodoro mode turned off mid-cycle — cancel the live cycle everywhere
            if (!this.settings.pomoEnabled && this.pomo.phase !== 'idle') {
              this.pomo = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
              pomoCancelled = true;
            }
          }
          if (this.invalidateDeletedTasks(e)) runningCleared = true;
        }
        if (runningCleared) {
          // cascade-deleted rows are already gone from D1; drop the ghost timer
          // and tell every device — then persist/reset pomo + alarms
          await this.persistPomo();
          await this.rearmAlarm();
          await this.logAndBroadcast({ id: 0, type: 'timer.stopped', actor: 'server', at: Date.now(), data: { session: null } });
        }
        if (pomoCancelled) {
          await this.persistPomo();
          await this.rearmAlarm();
          await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: Date.now(), data: { pomo: this.visiblePomo() } });
        }
        this.broadcastMany(body.events);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/ratelimit') {
      // Atomic per-user counter for the hot-path rate limit: the DO
      // is a single instance per user, so read-modify-write here is race-free
      // and puts no writes on a shared KV key. Counters are in-memory (reset on
      // eviction); the D1 rateLimitHit fallback in middleware is atomic anyway.
      const body = await request.json<{ key: string; limit: number; windowMs: number }>().catch(() => null);
      if (!body || typeof body.key !== 'string' || !Number.isFinite(body.limit) || body.limit < 1
        || !Number.isFinite(body.windowMs) || body.windowMs < 1000)
        return this.err(422, 'validation', 'invalid body');
      return Response.json(this.rateLimit(body.key, body.limit, body.windowMs));
    }
    if (url.pathname === '/timer') {
      const body = await request.json<{ op: 'start' | 'stop' | 'switch'; task_id?: string; subtask_id?: string | null; device: string }>().catch(() => null);
      if (!body) return this.err(422, 'validation', 'invalid body');
      if (body.op === 'start') return this.timerStart(body.task_id!, body.device, 'timer', body.subtask_id ?? null);
      if (body.op === 'stop') return this.timerStop(body.device);
      if (body.op === 'switch') return this.timerSwitch(body.task_id!, body.device, body.subtask_id ?? null);
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
    // sid = auth session id (verified by the Worker before the upgrade). Tagging
    // the socket with it makes selective /revoke possible (audit S1).
    const sid = url.searchParams.get('sid') ?? '';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], sid ? [device, sid] : [device]);
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

  /**
   * Subtask linkage for a session: when `subtaskId` is given it must belong to
   * `taskId` (and be visible in the task's scope — the task check upstream
   * already established that). Returns null when absent, a 422 Response on a
   * bad link.
   */
  private async validateSubtask(taskId: string, subtaskId: string | null): Promise<Response | null> {
    if (!subtaskId) return null;
    const row = await this.env.DB.prepare(
      'SELECT id FROM subtasks WHERE id = ?1 AND task_id = ?2'
    ).bind(subtaskId, taskId).first();
    return row ? null : this.err(422, 'invalid_subtask', 'the subtask does not belong to this task');
  }

  private async timerStart(taskId: string, device: string, source: 'timer' | 'pomodoro', subtaskId: string | null = null): Promise<Response> {
    if (this.running) {
      return this.err(409, 'already_running', 'a timer is already running — use switch', { running: this.running });
    }
    const task = await this.env.DB.prepare(
      `SELECT t.id, p.archived FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?1 AND (t.user_id = ?2
         OR p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?2))`
    ).bind(taskId, this.userId()).first<any>();
    if (!task) return this.err(404, 'not_found', 'task not found');
    if (task.archived) return this.err(422, 'archived', 'this project is archived — new timers are blocked on it');
    const badSub = await this.validateSubtask(taskId, subtaskId);
    if (badSub) return badSub;

    // pomodoro mode (FR-F0): a plain timer start IS a pomodoro start — engage
    // the focus cycle before the batch so the session source and the persisted
    // pomo_state stay consistent. Fresh cycle from idle/decide/ready; starting
    // during a break cancels the break (FR-F3) — same semantics as /pomo/start.
    const engaged = source === 'timer' && this.settings.pomoEnabled;
    const now = Date.now();
    if (engaged && this.pomo.phase !== 'focus') {
      this.pomo = { phase: 'focus', taskId, accumulatedFocusMs: 0, lastResumeMs: now, breakEndsAt: null };
    }

    const sessionId = ulid(now);
    const session: RunningSession = { id: sessionId, task_id: taskId, subtask_id: subtaskId, started_at: now, source: engaged ? 'pomodoro' : source };
    const ev = { type: 'timer.started', actor: device, data: { session, task_id: taskId } };

    // single ordered batch: session row + recovery mirror + sync_log (NFR-5: no partial writes)
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at, subtask_id)
           VALUES (?1, ?2, ?3, ?4, NULL, ?5, '', ?4, ?4, ?6)`
        ).bind(sessionId, this.userId(), taskId, now, session.source, subtaskId),
        this.env.DB.prepare(
          `INSERT INTO active_timers (user_id, task_id, session_id, started_at, pomo_state, subtask_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (user_id) DO UPDATE SET task_id = excluded.task_id,
             session_id = excluded.session_id, started_at = excluded.started_at, pomo_state = excluded.pomo_state,
             subtask_id = excluded.subtask_id`
        ).bind(this.userId(), taskId, sessionId, now, JSON.stringify(this.pomo), subtaskId),
        this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
      ]);
    } catch (e) {
      // D1 batch failed — most plausibly the partial unique index
      // (idx_sessions_running: one open session per user, e.g. a manual
      // open-ended row from an older version). Resync from the mirror instead
      // of throwing a 500 / keeping ghost state.
      this.running = await this.loadRunningFromD1();
      if (this.running) {
        return this.err(409, 'already_running', 'a timer is already running — use switch', { running: this.running });
      }
      console.error(JSON.stringify({ evt: 'timer_start_failed', user_id: this.userId(), message: String((e as Error)?.message ?? e) }));
      return this.err(503, 'timer_unavailable', 'could not start the timer — retry shortly');
    }
    this.running = session; // in-memory state only advances once D1 confirms
    this.nudgeNextAt = null; // fresh session → fresh 12h window
    const eventId = Number(results[2]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);
    this.broadcast({ id: eventId, type: 'timer.started', actor: device, at: now, data: ev.data });

    // social presence: friends watching a friends-visible project get the live
    // dot (no-op when the project is private or there are no friends)
    await broadcastFriendPresence(this.env, this.userId(), device, this.running);

    // pomodoro: resuming/starting focus accumulation with a live timer (FR-F1).
    // Only resume when no segment is already in flight — resetting an
    // in-flight lastResumeMs would discard accumulated live time.
    if (this.pomo.phase === 'focus') {
      if (this.pomo.lastResumeMs == null) this.pomo.lastResumeMs = now;
      if (this.pomo.taskId === null) this.pomo.taskId = taskId;
      await this.persistPomo();
      await this.rearmAlarm();
      if (engaged) {
        // the cycle (re)started — tell every device, and include the fresh
        // pomodoro state in the response (the actor device ignores its own echoes)
        await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: device, at: now, data: { pomo: this.visiblePomo() } });
      }
    }
    return Response.json({ session: this.running, pomo: this.visiblePomo(), events: [{ id: eventId, type: 'timer.started', actor: device, at: now, data: ev.data }] });
  }

  private async timerStop(device: string): Promise<Response> {
    if (!this.running) return this.err(409, 'not_running', 'no timer is running');
    const now = Date.now();
    const session = { ...this.running, ended_at: now };
    const ev = { type: 'timer.stopped', actor: device, data: { session } };

    // same failure posture as timerStart: resync from the mirror instead of
    // throwing a 500 / keeping ghost state (audit: error-handling parity)
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE time_sessions SET ended_at = ?1, updated_at = ?1 WHERE id = ?2'
        ).bind(now, session.id),
        this.env.DB.prepare('DELETE FROM active_timers WHERE user_id = ?1').bind(this.userId()),
        this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
          .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
      ]);
    } catch (e) {
      this.running = await this.loadRunningFromD1();
      console.error(JSON.stringify({ evt: 'timer_stop_failed', user_id: this.userId(), message: String((e as Error)?.message ?? e) }));
      return this.err(503, 'timer_unavailable', 'could not stop the timer — retry shortly');
    }
    const eventId = Number(results[2]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);

    // focus freezes when tracking stops (FR-F1) — no phase change
    if (this.pomo.phase === 'focus' && this.pomo.lastResumeMs) {
      this.pomo.accumulatedFocusMs += now - this.pomo.lastResumeMs;
      this.pomo.lastResumeMs = null;
      await this.persistPomo();
    }
    this.running = null;
    this.nudgeNextAt = null;
    await this.rearmAlarm();
    this.broadcast({ id: eventId, type: 'timer.stopped', actor: device, at: now, data: ev.data });
    await broadcastFriendPresence(this.env, this.userId(), device, null); // clear the live dot
    return Response.json({ session, events: [{ id: eventId, type: 'timer.stopped', actor: device, at: now, data: ev.data }] });
  }

  /** Atomic stop-old + start-new — one call, one event, zero overlap/gap (FR-S1 AC).
   *  `subtaskId` (optional) re-anchors the subtask too — switching subtasks,
   *  even within the same task, splits into two cleanly-attributed sessions. */
  private async timerSwitch(taskId: string, device: string, subtaskId: string | null = null): Promise<Response> {
    if (!this.running) {
      // tolerate: treat as start
      return this.timerStart(taskId, device, 'timer', subtaskId);
    }
    const task = await this.env.DB.prepare(
      `SELECT t.id, p.archived FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?1 AND (t.user_id = ?2
         OR p.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?2))`
    ).bind(taskId, this.userId()).first<any>();
    if (!task) return this.err(404, 'not_found', 'task not found');
    if (task.archived) return this.err(422, 'archived', 'this project is archived — new timers are blocked on it');
    const badSub = await this.validateSubtask(taskId, subtaskId);
    if (badSub) return badSub;
    if (task.id === this.running.task_id && (this.running.subtask_id ?? null) === (subtaskId ?? null)) {
      return Response.json({ session: this.running, events: [] }); // same task AND subtask — nothing to switch
    }

    // pomodoro mode (FR-F0): a switch mid-cycle keeps the focus run alive on
    // the new task (the in-flight focus segment just continues) and the new
    // session is tagged 'pomodoro' — re-anchor before the batch so the
    // persisted pomo_state stays consistent.
    const engaged = this.settings.pomoEnabled;
    if (engaged && this.pomo.phase !== 'idle') this.pomo.taskId = taskId;

    const now = Date.now();
    const stopped = { ...this.running, ended_at: now };
    const newId = ulid(now + 1);
    const newSource: 'timer' | 'pomodoro' = engaged ? 'pomodoro' : 'timer';
    const started: RunningSession = { id: newId, task_id: taskId, subtask_id: subtaskId, started_at: now + 1, source: newSource };
    const ev = { type: 'timer.switched', actor: device, data: { stopped, started } };

    const results = await this.env.DB.batch([
      this.env.DB.prepare('UPDATE time_sessions SET ended_at = ?1, updated_at = ?1 WHERE id = ?2')
        .bind(now, stopped.id),
      this.env.DB.prepare(
        `INSERT INTO time_sessions (id, user_id, task_id, started_at, ended_at, source, note, created_at, updated_at, subtask_id)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, '', ?4, ?4, ?6)`
      ).bind(newId, this.userId(), taskId, now + 1, newSource, subtaskId),
      this.env.DB.prepare(
        `UPDATE active_timers SET task_id = ?2, session_id = ?3, started_at = ?4, pomo_state = ?5, subtask_id = ?6 WHERE user_id = ?1`
      ).bind(this.userId(), taskId, newId, now + 1, JSON.stringify(this.pomo), subtaskId),
      this.env.DB.prepare('INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), now)
    ]).catch(async (e) => {
      // mirror-resync on failure, same posture as timerStart/timerStop
      this.running = await this.loadRunningFromD1();
      console.error(JSON.stringify({ evt: 'timer_switch_failed', user_id: this.userId(), message: String((e as Error)?.message ?? e) }));
      return null;
    });
    if (!results) return this.err(503, 'timer_unavailable', 'could not switch the timer — retry shortly');
    const eventId = Number(results[3]?.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, eventId);
    this.running = started;
    this.nudgeNextAt = null;
    if (engaged) await this.persistPomo(); // re-anchored cycle → refresh the kv mirror
    await this.rearmAlarm();
    this.broadcast({ id: eventId, type: 'timer.switched', actor: device, at: now, data: ev.data });
    await broadcastFriendPresence(this.env, this.userId(), device, started);
    return Response.json({ stopped, started, pomo: this.visiblePomo(), events: [{ id: eventId, type: 'timer.switched', actor: device, at: now, data: ev.data }] });
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
      return this.pomoPhaseResponse(device);
    }
    if (this.pomo.phase === 'focus') {
      // idempotent restart: an in-flight focus segment keeps its accumulated
      // time — only seed lastResumeMs when no segment is running
      if (this.pomo.lastResumeMs == null) this.pomo.lastResumeMs = Date.now();
      await this.persistPomo();
    }
    await this.rearmAlarm();
    return this.pomoPhaseResponse(device);
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
    return this.pomoPhaseResponse(device);
  }

  /** Skippable from any non-idle phase; resets to idle, discards progress, logs nothing (FR-F4). */
  private async pomoSkip(device: string): Promise<Response> {
    if (this.pomo.phase === 'idle') return Response.json({ pomo: this.visiblePomo() });
    this.pomo = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
    await this.persistPomo();
    await this.rearmAlarm();
    return this.pomoPhaseResponse(device);
  }

  // no `phase` argument: the response reports the DO's own state via visiblePomo(),
  // so a passed-in phase could only ever disagree with it
  private async pomoPhaseResponse(device: string): Promise<Response> {
    const now = Date.now();
    const ev: WsEvent = { id: 0, type: 'pomodoro.phase', actor: device, at: now, data: { pomo: this.visiblePomo() } };
    const result = await this.env.DB.prepare(
      'INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(this.userId(), ev.type, JSON.stringify({ actor: device, data: ev.data }), now).run();
    ev.id = Number(result.meta.last_row_id ?? 0);
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
    if (this.running) {
      // 12h nudge: after the first fire this repeats hourly (nudgeNextAt), never
      // re-arming a deadline that is already in the past — that would make the
      // alarm refire immediately in a loop (audit)
      const nudgeAt = this.nudgeNextAt ?? (this.running.started_at + TWELVE_H);
      if (nudgeAt > now) deadlines.push(nudgeAt);
    }
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

    // 12h running failsafe — nudge only, never auto-stop (§5.7); repeats hourly
    // while the timer stays past the threshold (audit: no per-tick loop)
    if (this.running && now >= (this.nudgeNextAt ?? (this.running.started_at + TWELVE_H))) {
      this.nudgeNextAt = now + 3600_000;
      await this.logAndBroadcast({ id: 0, type: 'timer.nudge', actor: 'server', at: now, data: { running_since: this.running.started_at } });
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
        if (!this.running) {
          const r = await this.timerStart(target, 'server', 'pomodoro');
          if (r.status !== 200) {
            // auto-start failed — roll the phase back to 'ready' so the state
            // machine doesn't claim focus with no timer behind it (audit)
            this.pomo = { phase: 'ready', taskId: target, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
            await this.persistPomo();
            await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: Date.now(), data: { pomo: this.visiblePomo() } });
            await this.rearmAlarm();
            return;
          }
        }
        await this.logAndBroadcast({ id: 0, type: 'pomodoro.phase', actor: 'server', at: now, data: { pomo: this.visiblePomo() } });
      }
    }

    await this.rearmAlarm();
  }

  private async logAndBroadcast(ev: WsEvent): Promise<void> {
    const result = await this.env.DB.prepare(
      'INSERT INTO sync_log (user_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(this.userId(), ev.type, JSON.stringify({ actor: ev.actor, data: ev.data }), ev.at).run();
    ev.id = Number(result.meta.last_row_id ?? 0);
    this.lastEventId = Math.max(this.lastEventId, ev.id);
    this.broadcast(ev);
  }

  // ---------- fan-out ----------

  /**
   * Cascade deletes (task/project) remove time_sessions + active_timers rows in
   * D1, but the DO holds the running session in memory — clear it here when the
   * deleted subtree contained it. Returns true when state changed.
   */
  private invalidateDeletedTasks(e: WsEvent): boolean {
    const d = e.data as any;
    const ids = new Set<string>();
    if (e.type === 'task.deleted' && d?.task?.id) ids.add(d.task.id);
    if (e.type === 'project.deleted' && Array.isArray(d?.tasks)) {
      for (const t of d.tasks) if (t?.id) ids.add(t.id);
    }
    if (ids.size === 0) return false;
    let changed = false;
    if (this.running && ids.has(this.running.task_id)) {
      this.running = null;
      changed = true;
    }
    if (this.pomo.taskId && ids.has(this.pomo.taskId)) {
      // the cycle's anchor task is gone — cancel the cycle without logging time
      this.pomo = { phase: 'idle', taskId: null, accumulatedFocusMs: 0, lastResumeMs: null, breakEndsAt: null };
      changed = true;
    }
    return changed;
  }

  private rateLimit(key: string, limit: number, windowMs: number): { limited: boolean; retry_after_s: number } {
    const now = Date.now();
    const win = Math.floor(now / windowMs);
    const k = `${win}:${key}`;
    const cur = (this.rl.get(k) ?? 0) + 1;
    this.rl.set(k, cur);
    if (this.rl.size > 64) {
      for (const [k2] of this.rl) {
        if (Number(k2.split(':', 1)[0]) < win) this.rl.delete(k2);
      }
    }
    if (cur > limit) return { limited: true, retry_after_s: Math.ceil((windowMs - (now % windowMs)) / 1000) };
    return { limited: false, retry_after_s: 0 };
  }

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
