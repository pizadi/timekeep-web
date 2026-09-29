// Period-end goal notifications (v0.6.0). Client-side by design: there is no
// server cron per user, so the scheduler lives here — when a goal's period
// boundary passes while the app is open, progress is refetched and one
// notification per affected goal fires (met/missed).
//
// Rules respected (AGENTS.md): browser permission is NEVER requested here —
// goal notifications are "every other notification", so they fire only when
// the user already granted permission via the Settings toggle (or pomodoro).
// Background tabs throttle timers; a visibilitychange catch-up re-checks when
// the tab becomes visible, so a frozen tab reports on return.
import { store } from './store';
import { api } from './api';
import { windowMet } from '../../shared/goals';

interface ProgressEntry {
  goal: { id: string; name: string; direction: 'at_least' | 'at_most' };
  status: string;
  windows: { start: number; end: number; target: number; actual: number; elapsed: boolean; current: boolean }[];
}

let armed = false;
let timer: number | null = null;
/** Per goal: the end of the newest window we've already accounted for. The
 *  first observation seeds the map silently — no notification dump for windows
 *  that ended before this tab loaded. */
const lastSeen = new Map<string, number>();

function fmtHM(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

function notify(body: string): void {
  const settings = store.get().settings;
  if (!settings?.notifications_enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('TimeKeep', { body, tag: 'timekeep-goals' });
    setTimeout(() => n.close(), 8000);
  } catch {
    /* notification quirks are non-fatal */
  }
}

async function check(): Promise<void> {
  if (!store.get().authed) return rearm(null);
  const active = store.get().goals;
  if (active.length === 0) return rearm(null); // nothing to schedule against
  let next: number | null = null;
  try {
    const r = await api<{ goals: ProgressEntry[] }>('/goals/progress?windows=2');
    for (const e of r.goals) {
      if (e.status !== 'active') continue;
      const seen = lastSeen.get(e.goal.id);
      const freshlyEnded = e.windows.filter((w) => w.elapsed && (seen === undefined || w.end > seen));
      if (freshlyEnded.length > 0) {
        // only the NEWEST ended window is reported — being away for a week
        // must not dump seven dailies at once
        const w = freshlyEnded[freshlyEnded.length - 1]!;
        lastSeen.set(e.goal.id, w.end);
        if (seen !== undefined) {
          const met = windowMet(e.goal.direction, w.actual, w.target);
          const title = e.goal.name || 'Goal';
          const body = met
            ? `${title}: period ended at ${fmtHM(w.actual)} of ${fmtHM(w.target)} — target met 🎉`
            : `${title}: period ended at ${fmtHM(w.actual)} of ${fmtHM(w.target)} — not met`;
          notify(body);
        }
      } else if (seen === undefined) {
        // first observation: seed silently from the newest elapsed window
        const newest = e.windows.filter((w) => w.elapsed).pop();
        if (newest) lastSeen.set(e.goal.id, newest.end);
      }
      const cur = e.windows.find((w) => w.current);
      if (cur) next = next === null ? cur.end : Math.min(next, cur.end);
    }
  } catch {
    /* offline — the reconcile poll and the next tick will retry */
  }
  rearm(next);
}

/** Schedule the next check: just past the earliest open boundary (so the
 *  server's own `now` has already flipped the window), or a slow idle poll. */
function rearm(at: number | null): void {
  if (timer !== null) window.clearTimeout(timer);
  const delay = at === null ? 300_000 : Math.max(5_000, at - Date.now() + 2_000);
  timer = window.setTimeout(() => {
    timer = null;
    void check();
  }, delay);
}

/** Install once (from store.boot): boundary checks run app-wide afterwards. */
export function armGoalNotifications(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  void check();
}
