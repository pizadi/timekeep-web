// Timer bar + pomodoro ring (FR-F6) + tab-title/favicon "tray" (FR-U5) +
// recovery banner (FR-S3) + Web Notifications (FR-Nt1).
import { useEffect, useRef, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import { api, nowMs, serverOffsetMs } from '../lib/api';
import { fmtHMS } from '../lib/time';
import { resumeLastTask, stopTimer } from '../lib/actions';
import { SESSION_RULES } from '../../shared/constants';
import { useModalA11y } from '../lib/modal';
import { useHasHover } from '../lib/responsive';

export default function TimerBar() {
  const running = useStore((s) => s.running);
  const tasks = useStore((s) => s.tasks);
  const recentEntries = useStore((s) => s.recentEntries);
  const subtasks = useStore((s) => s.subtasks);
  const pomo = useStore((s) => s.pomo);
  const pomoEnabled = useStore((s) => s.settings?.pomodoro?.enabled ?? false);
  const hasHover = useHasHover(); // "press T" presumes a keyboard
  const [elapsed, setElapsed] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const promptedRef = useRef(false);

  const task = running ? tasks.find((t) => t.id === running.task_id) : null;
  const subtask = running?.subtask_id ? (subtasks.find((sb) => sb.id === running.subtask_id) ?? null) : null;
  const runningLabel = task ? (subtask ? `${task.name} ▸ ${subtask.name}` : task.name) : 'Unknown task';
  // "most recently tracked task" (R shortcut / Resume button) — on the subtask
  // it last tracked, when that session was attributed to one
  const last = recentEntries[0] ?? null;
  const lastTask = last ? (tasks.find((t) => t.id === last.task_id) ?? null) : null;
  const lastSubtask = last?.subtask_id ? (subtasks.find((sb) => sb.id === last.subtask_id) ?? null) : null;
  const lastLabel = lastTask ? (lastSubtask ? `${lastTask.name} ▸ ${lastSubtask.name}` : lastTask.name) : '';

  // elapsed computed client-side from authoritative started_at + server offset (FR-S2);
  // keeps ticking even when the WS drops. Deps are [running] only — depending on
  // serverNow too tore the interval down and rebuilt it every second (audit).
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const compute = () => setElapsed(Math.max(0, nowMs() - running.started_at));
    compute();
    const iv = setInterval(compute, 1000);
    return () => clearInterval(iv);
  }, [running]);

  // FR-S3: a timer that was already running when this tab loaded gets a one-time
  // recovery prompt
  useEffect(() => {
    if (!running || promptedRef.current) return;
    promptedRef.current = true;
    if (running.started_at < Date.now() - 5000) setRecovering(true);
  }, [running]);

  // tab title + favicon badge = web tray icon (FR-U5)
  useEffect(() => {
    const base = 'TimeKeep';
    if (running) {
      document.title = `${fmtHMS(elapsed)} · ${runningLabel}`;
      setFavicon(true);
    } else {
      document.title = base;
      setFavicon(false);
    }
  }, [running, elapsed, runningLabel]);

  // pomodoro notifications (FR-Nt1) — end-of-run phases (decide/ready) always
  // notify when the browser permission is granted (they were requested when the
  // user enabled pomodoro mode); other phase changes follow the Settings toggle
  const prevPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!pomo) {
      prevPhase.current = null;
      return;
    }
    const phase = pomo.phase;
    if (prevPhase.current && prevPhase.current !== phase) {
      const msgs: Record<string, string> = {
        decide: 'Focus block complete — start a break or skip?',
        break: 'Break started — step away for a bit',
        ready: 'Break over — ready for the next focus',
        focus: 'Focus phase started',
        idle: 'Pomodoro stopped',
      };
      const msg = msgs[phase] ?? phase;
      pushToast('info', msg);
      notifyIfPermitted(msg, phase === 'decide' || phase === 'ready'); // one notification per phase change
    }
    prevPhase.current = phase;
  }, [pomo?.phase]);

  async function stop() {
    await stopTimer();
  }

  async function discardAndEdit() {
    setRecovering(false);
    if (!running) return;
    const grace = (store.get().settings?.grace_min ?? SESSION_RULES.graceMin) * 60_000;
    try {
      const res = await api<{ session: { id: string; task_id: string; started_at: number } }>('/timer/stop', {
        method: 'POST',
      });
      store.setRunning(null);
      // open the session editor with a suggested end of "now − grace" (FR-S3 AC)
      store.navigateToView('log');
      window.dispatchEvent(
        new CustomEvent('tk:edit-session', {
          detail: {
            id: res.session?.id,
            task_id: res.session?.task_id,
            started_at: res.session?.started_at ?? running.started_at,
            ended_at: Date.now() - grace,
          },
        }),
      );
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  if (!running) {
    return (
      <div className="timerbar muted" style={{ justifyContent: 'center' }}>
        {pomoEnabled ? (
          hasHover ? (
            <>
              Pomodoro on — press <b style={{ margin: '0 6px' }}>T</b> on a selected task to start a focus block
            </>
          ) : (
            <>Pomodoro on — tap ▶ on a task to start a focus block</>
          )
        ) : hasHover ? (
          <>
            No timer running — press <b style={{ margin: '0 6px' }}>T</b> on a selected task
          </>
        ) : (
          <>No timer running — tap ▶ on a task</>
        )}
        {lastTask && (
          <button
            className="btn small"
            style={{ marginLeft: 10 }}
            title={
              lastLabel.length > 24
                ? `Resume tracking on “${lastLabel}”`
                : `Resume tracking on the last ${lastSubtask ? 'subtask' : 'task'} (R)`
            }
            onClick={() => void resumeLastTask()}
          >
            ▶ Resume “{lastLabel.length > 24 ? `${lastLabel.slice(0, 23)}…` : lastLabel}”
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="timerbar" role="timer" aria-live="off">
        <span className="dot-running" aria-hidden />
        <span className="elapsed">{fmtHMS(elapsed)}</span>
        <span className="task" title={runningLabel}>
          {runningLabel}
        </span>
        <PomodoroRing />
        <div className="spacer" />
        <button className="btn stop" onClick={stop}>
          ■ Stop
        </button>
      </div>
      {recovering && <RecoveryPrompt onClose={() => setRecovering(false)} onDiscard={discardAndEdit} />}
    </>
  );
}

/** Progress ring + decide prompt (FR-F2/F6). */
function PomodoroRing() {
  const pomo = useStore((s) => s.pomo);
  const running = useStore((s) => s.running);
  const serverNow = useStore((s) => s.serverNow);
  if (!pomo || pomo.phase === 'idle') return null;
  const goal = Math.max(1, pomo.focus_goal_ms);
  // focus_ms_live / break_ms_left are DO-clock snapshots taken at the last
  // phase event. Advance them by the time since the snapshot
  // (server-corrected), so the ring/labels tick every second with serverNow.
  // Focus advances only while a timer actually runs (FR-F1): a stopped timer
  // freezes focus_ms_live, and advancing it here would inflate the ring.
  const snapshotClientMs = (pomo.server_now ?? serverNow) - serverOffsetMs;
  const sinceSnapshot = Math.max(0, serverNow - snapshotClientMs);
  const focusLive = Math.min(goal, pomo.focus_ms_live + (running && pomo.phase === 'focus' ? sinceSnapshot : 0));
  const breakLeft = Math.max(0, (pomo.break_ms_left ?? 0) - sinceSnapshot);
  const live = pomo.phase === 'break' || pomo.phase === 'ready' ? goal : focusLive;
  const frac = pomo.phase === 'break' ? 1 - breakLeft / Math.max(1, pomo.break_ms_total) : live / goal;
  const color = pomo.phase === 'break' ? 'var(--ok)' : pomo.phase === 'decide' ? 'var(--warn)' : 'var(--accent)';
  const R = 13,
    C = 2 * Math.PI * R;

  async function startBreak() {
    try {
      const res = await api<{ pomo: any }>('/pomo/start-break', { method: 'POST' });
      store.setPomo(res.pomo);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }
  async function skip() {
    try {
      const res = await api<{ pomo: any }>('/pomo/skip', { method: 'POST' });
      store.setPomo(res.pomo);
    } catch (e: any) {
      pushToast('error', e.message);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`Pomodoro: ${pomo.phase}`}>
      <svg className="progress-ring" viewBox="0 0 34 34" aria-hidden>
        <circle cx="17" cy="17" r={R} fill="none" stroke="var(--border)" strokeWidth="3.5" />
        <circle
          cx="17"
          cy="17"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeDasharray={`${C * frac} ${C}`}
          strokeLinecap="round"
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span className="sub" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {pomo.phase === 'break'
          ? `break ${Math.ceil(breakLeft / 1000 / 60)}m`
          : pomo.phase === 'decide'
            ? 'goal!'
            : pomo.phase === 'ready'
              ? 'ready'
              : `${Math.floor(focusLive / 60000)}/${Math.round(goal / 60000)}m`}
      </span>
      {pomo.phase === 'decide' && (
        <>
          <button className="btn small primary" onClick={startBreak}>
            Start break
          </button>
          <button className="btn small" onClick={skip}>
            Skip
          </button>
        </>
      )}
      {(pomo.phase === 'break' || pomo.phase === 'focus' || pomo.phase === 'ready') && (
        <button className="btn ghost small" onClick={skip} aria-label="Skip pomodoro phase">
          skip
        </button>
      )}
    </span>
  );
}

/** Recovery banner shown after boot when a timer was already running (FR-S3). */
export function RecoveryPrompt({ onClose, onDiscard }: { onClose: () => void; onDiscard: () => void }) {
  const running = useStore((s) => s.running);
  const settings = useStore((s) => s.settings);
  const tasks = useStore((s) => s.tasks);
  const modalRef = useModalA11y(onClose);
  if (!running) return null;
  const task = tasks.find((t) => t.id === running.task_id);
  const grace = (settings?.grace_min ?? SESSION_RULES.graceMin) * 60_000;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Recover running timer">
      <div ref={modalRef} className="modal">
        <h3>Timer still running</h3>
        <p>
          “{task?.name ?? 'A task'}” has been running since <b>{new Date(running.started_at).toLocaleTimeString()}</b> —
          it kept counting while you were away.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={onClose}>
            Keep
          </button>
          <button className="btn" onClick={onDiscard}>
            Discard (opens editor)
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          Discard suggests an end time of “now − {grace / 60000} min” in the session editor (configurable in Settings).
        </p>
      </div>
    </div>
  );
}

function setFavicon(active: boolean): void {
  const link = document.getElementById('favicon') as HTMLLinkElement | null;
  if (!link) return;
  if (!active) {
    link.href = '/favicon.svg';
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#4f8cff';
  roundRect(ctx, 4, 4, 56, 56, 14);
  ctx.fill();
  ctx.fillStyle = '#ff5b5b';
  ctx.beginPath();
  ctx.arc(45, 19, 11, 0, Math.PI * 2);
  ctx.fill();
  link.href = canvas.toDataURL('image/png');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function notifyIfPermitted(body: string, force = false): Promise<void> {
  const settings = store.get().settings;
  // end-of-run notifications (force) only need the browser permission — they
  // were opted in when pomodoro mode was enabled; the rest need the toggle too
  if (!force && !settings?.notifications_enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('TimeKeep', { body, tag: 'timekeep-pomo' });
    if (settings?.sound_enabled) beep();
    setTimeout(() => n.close(), 8000);
  } catch {
    /* notification quirks are non-fatal */
  }
}

function beep(): void {
  try {
    const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* audio is best-effort */
  }
}
