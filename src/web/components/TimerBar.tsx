// Timer bar + pomodoro ring (FR-F6) + tab-title/favicon "tray" (FR-U5) +
// recovery banner (FR-S3) + Web Notifications (FR-Nt1).
import { useEffect, useRef, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import { api, ApiError, nowMs, serverOffsetMs } from '../lib/api';
import { fmtHMS } from '../lib/time';

export default function TimerBar() {
  const running = useStore((s) => s.running);
  const tasks = useStore((s) => s.tasks);
  const pomo = useStore((s) => s.pomo);
  const serverNow = useStore((s) => s.serverNow);
  const [elapsed, setElapsed] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const promptedRef = useRef(false);

  const task = running ? tasks.find((t) => t.id === running.task_id) : null;

  // elapsed computed client-side from authoritative started_at + server offset (FR-S2);
  // keeps ticking even when the WS drops
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const compute = () => setElapsed(Math.max(0, nowMs() - running.started_at));
    compute();
    const iv = setInterval(compute, 1000);
    return () => clearInterval(iv);
  }, [running, serverNow]);

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
      document.title = `${fmtHMS(elapsed)} · ${task?.name ?? 'Timer'}`;
      setFavicon(true);
    } else {
      document.title = base;
      setFavicon(false);
    }
  }, [running, elapsed, task?.name]);

  // pomodoro notifications (FR-Nt1) — only when the user enabled them
  const prevPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!pomo) { prevPhase.current = null; return; }
    const phase = pomo.phase;
    if (prevPhase.current && prevPhase.current !== phase) {
      const msgs: Record<string, string> = {
        decide: 'Focus goal reached — start a break or skip?',
        break: 'Break started — step away for a bit',
        ready: 'Break over — ready for the next focus',
        focus: 'Focus phase started',
        idle: 'Pomodoro stopped'
      };
      const msg = msgs[phase] ?? phase;
      pushToast('info', msg);
      notifyIfPermitted(msg); // exactly one notification per phase change
    }
    prevPhase.current = phase;
  }, [pomo?.phase]);

  async function stop() {
    try {
      await api('/timer/stop', { method: 'POST' });
      store.setRunning(null);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function discardAndEdit() {
    setRecovering(false);
    if (!running) return;
    const grace = (store.get().settings?.grace_min ?? 15) * 60_000;
    try {
      const res = await api<{ session: { id: string; task_id: string; started_at: number } }>('/timer/stop', { method: 'POST' });
      store.setRunning(null);
      // open the session editor with a suggested end of "now − grace" (FR-S3 AC)
      store.navigateToView('log');
      window.dispatchEvent(new CustomEvent('tk:edit-session', {
        detail: {
          id: res.session?.id,
          task_id: res.session?.task_id,
          started_at: res.session?.started_at ?? running.started_at,
          ended_at: Date.now() - grace
        }
      }));
    } catch (e: any) { pushToast('error', e.message); }
  }

  if (!running) return <div className="timerbar muted" style={{ justifyContent: 'center' }}>No timer running — press <b style={{ margin: '0 6px' }}>T</b> on a selected task</div>;

  return (
    <>
      <div className="timerbar" role="timer" aria-live="off">
        <span className="dot-running" aria-hidden />
        <span className="elapsed">{fmtHMS(elapsed)}</span>
        <span className="task">{task?.name ?? 'Unknown task'}</span>
        <PomodoroRing />
        <div className="spacer" />
        <button className="btn stop" onClick={stop}>■ Stop</button>
      </div>
      {recovering && (
        <RecoveryPrompt
          onClose={() => setRecovering(false)}
          onDiscard={discardAndEdit}
        />
      )}
    </>
  );
}

/** Progress ring + decide prompt (FR-F2/F6). */
function PomodoroRing() {
  const pomo = useStore((s) => s.pomo);
  const serverNow = useStore((s) => s.serverNow);
  if (!pomo || pomo.phase === 'idle') return null;
  const goal = Math.max(1, pomo.focus_goal_ms);
  // focus_ms_live / break_ms_left are DO-clock snapshots taken at the last
  // phase event. Advance them by the time since the snapshot
  // (server-corrected), so the ring/labels tick every second with serverNow.
  const snapshotClientMs = (pomo.server_now ?? serverNow) - serverOffsetMs;
  const sinceSnapshot = Math.max(0, serverNow - snapshotClientMs);
  const focusLive = Math.min(goal, pomo.focus_ms_live + sinceSnapshot);
  const breakLeft = Math.max(0, (pomo.break_ms_left ?? 0) - sinceSnapshot);
  const live = pomo.phase === 'break' || pomo.phase === 'ready' ? goal : focusLive;
  const frac = pomo.phase === 'break'
    ? 1 - breakLeft / Math.max(1, pomo.break_ms_total)
    : live / goal;
  const color = pomo.phase === 'break' ? 'var(--ok)' : pomo.phase === 'decide' ? 'var(--warn)' : 'var(--accent)';
  const R = 13, C = 2 * Math.PI * R;

  async function startBreak() {
    try {
      const res = await api<{ pomo: any }>('/pomo/start-break', { method: 'POST' });
      store.setPomo(res.pomo);
    } catch (e: any) { pushToast('error', e.message); }
  }
  async function skip() {
    try {
      const res = await api<{ pomo: any }>('/pomo/skip', { method: 'POST' });
      store.setPomo(res.pomo);
    } catch (e: any) { pushToast('error', e.message); }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`Pomodoro: ${pomo.phase}`}>
      <svg className="progress-ring" viewBox="0 0 34 34" aria-hidden>
        <circle cx="17" cy="17" r={R} fill="none" stroke="var(--border)" strokeWidth="3.5" />
        <circle cx="17" cy="17" r={R} fill="none" stroke={color} strokeWidth="3.5"
          strokeDasharray={`${C * frac} ${C}`} strokeLinecap="round"
          transform="rotate(-90 17 17)" />
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
          <button className="btn small primary" onClick={startBreak}>Start break</button>
          <button className="btn small" onClick={skip}>Skip</button>
        </>
      )}
      {(pomo.phase === 'break' || pomo.phase === 'focus' || pomo.phase === 'ready') && (
        <button className="btn ghost small" onClick={skip} aria-label="Skip pomodoro phase">skip</button>
      )}
    </span>
  );
}

/** Recovery banner shown after boot when a timer was already running (FR-S3). */
export function RecoveryPrompt({ onClose, onDiscard }: {
  onClose: () => void;
  onDiscard: () => void;
}) {
  const running = useStore((s) => s.running);
  const settings = useStore((s) => s.settings);
  const tasks = useStore((s) => s.tasks);
  if (!running) return null;
  const task = tasks.find((t) => t.id === running.task_id);
  const grace = (settings?.grace_min ?? 15) * 60_000;
  return (
    <div className="modal-overlay" role="dialog" aria-label="Recover running timer">
      <div className="modal">
        <h3>Timer still running</h3>
        <p>
          “{task?.name ?? 'A task'}” has been running since{' '}
          <b>{new Date(running.started_at).toLocaleTimeString()}</b> — it kept counting while you were away.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={onClose}>Keep</button>
          <button className="btn" onClick={onDiscard}>Discard (opens editor)</button>
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
  if (!active) { link.href = '/favicon.svg'; return; }
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#4f8cff';
  roundRect(ctx, 4, 4, 56, 56, 14);
  ctx.fill();
  ctx.fillStyle = '#ff5b5b';
  ctx.beginPath(); ctx.arc(45, 19, 11, 0, Math.PI * 2); ctx.fill();
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

async function notifyIfPermitted(body: string): Promise<void> {
  const settings = store.get().settings;
  if (!settings?.notifications_enabled) return; // permission only requested from Settings toggle (FR-Nt1)
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('TimeKeep', { body, tag: 'timekeep-pomo' });
    if (settings.sound_enabled) beep();
    setTimeout(() => n.close(), 8000);
  } catch { /* notification quirks are non-fatal */ }
}

function beep(): void {
  try {
    const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
    setTimeout(() => void ctx.close(), 600);
  } catch { /* audio is best-effort */ }
}

export { ApiError, nowMs };
