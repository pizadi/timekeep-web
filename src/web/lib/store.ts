// Global store: bootstrap state, idempotent WS/poll event reconciliation
// (last-write-wins at entity level, FR-N3), undo toasts, reports invalidation.
import { useSyncExternalStore } from 'react';
import type { WsEvent } from '../../shared/constants';
import { LIMITS } from '../../shared/constants';
import { api, getDeviceId, wsUrl, ApiError } from './api';
import { mergeRecent, recentFromBootstrap, type RecentEntry } from './recent';
import { deviceTimezone } from './time';

export interface Project { id: string; user_id?: string; name: string; color: string; archived: 0 | 1; position: number; visibility?: 'private' | 'friends'; group_id?: string | null; created_at: number; updated_at: number }
export interface Task { id: string; project_id: string; parent_id: string | null; name: string; notes: string; done: 0 | 1; position: number; created_at: number; updated_at: number }
export interface Subtask { id: string; task_id: string; name: string; done: 0 | 1; position: number; created_at: number }
export interface Dependency { task_id: string; depends_on_id: string; created_at: number }
export interface SessionRow { id: string; task_id: string; subtask_id?: string | null; started_at: number; ended_at: number | null; source: 'timer' | 'manual' | 'pomodoro'; note: string; created_at: number; updated_at: number }
export interface RunningSession { id: string; task_id: string; subtask_id?: string | null; started_at: number; source: string; ended_at?: null }
export interface PomoState {
  phase: 'idle' | 'focus' | 'decide' | 'break' | 'ready';
  taskId: string | null;
  focus_ms_live: number; focus_goal_ms: number;
  break_ms_left: number | null; break_ms_total: number;
  server_now?: number;
}

export interface Settings {
  pomodoro: { enabled: boolean; focus_min: number; break_min: number; auto_start: boolean };
  grace_min: number;
  notifications_enabled: boolean;
  sound_enabled: boolean;
  theme: 'system' | 'light' | 'dark';
}
export interface UserProfile {
  id: string; username: string; email: string; name: string; timezone: string;
  week_start: number; theme: 'system' | 'light' | 'dark'; // 0–6 since migration 0003
  role: 'user' | 'admin';
  must_change_password: boolean;
  email_verified_at: number | null; created_at: number;
}

// ---------- social (phase 1: friends + visibility) ----------
export interface FriendSummary { id: string; username: string; name: string; since?: number }
export interface FriendRequestRow { request_id: string; created_at: number; user_id: string; username: string; name: string }
/** A friend's live tracking state — only for friends-visible projects. */
export interface FriendPresence { project_id: string; task_id: string; task_name: string; started_at: number }

// ---------- social (phase 2: groups) ----------
export interface GroupSummary {
  id: string; name: string; color: string; owner_id: string;
  role: 'owner' | 'admin' | 'member';
  perms: string;               // raw JSON array of GROUP_PERMS keys (parse client-side)
  created_at: number; member_count: number;
  unread: number;              // chat messages since last_read_at (others' only)
}
export interface GroupInviteRow {
  invite_id: string; created_at: number; group_id: string;
  name: string; color: string; inviter_username: string; inviter_name: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'undo';
  message: string;
  undoPayload?: () => Promise<unknown>;
  until: number; // timestamp to auto-dismiss
}

export interface AppState {
  booted: boolean;
  authed: boolean;
  user: UserProfile | null;
  settings: Settings | null;
  projects: Project[];
  tasks: Task[];
  subtasks: Subtask[];
  deps: Dependency[];
  running: RunningSession | null;
  pomo: PomoState | null;
  connection: 'online' | 'reconnecting' | 'offline';
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  view: 'tree' | 'log' | 'map' | 'dashboard' | 'social';
  recentEntries: RecentEntry[]; // "Jump back in" / Resume — newest-first, one per task, with its last subtask
  reportsVersion: number;      // bumped on relevant events → charts refetch (FR-R5)
  toasts: Toast[];
  lastEventId: number;
  serverNow: number;
  // social layer
  friends: FriendSummary[];
  incoming: FriendRequestRow[];
  outgoing: FriendRequestRow[];
  friendPresence: Record<string, FriendPresence | null>; // keyed by friend id
  groups: GroupSummary[];
  groupInvites: GroupInviteRow[];
}

let state: AppState = {
  booted: false,
  authed: false,
  user: null,
  settings: null,
  projects: [],
  tasks: [],
  subtasks: [],
  deps: [],
  running: null,
  pomo: null,
  connection: 'reconnecting',
  selectedProjectId: null,
  selectedTaskId: null,
  view: 'tree',
  recentEntries: [],
  reportsVersion: 0,
  toasts: [],
  lastEventId: 0,
  serverNow: Date.now(),
  friends: [],
  incoming: [],
  outgoing: [],
  friendPresence: {},
  groups: [],
  groupInvites: []
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export let bootRetry: number | null = null;

export const store = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },

  // ---------- bootstrap ----------
  async boot(): Promise<void> {
    try {
      const b = await api<any>('/bootstrap');
      if (bootRetry !== null) { window.clearTimeout(bootRetry); bootRetry = null; }
      state = {
        ...state,
        booted: true,
        authed: true,
        user: b.user,
        settings: b.settings,
        projects: b.projects,
        tasks: b.tasks,
        subtasks: b.subtasks,
        deps: b.dependencies,
        recentEntries: recentFromBootstrap(b),
        running: b.running ?? null,
        pomo: b.pomo ?? null,
        lastEventId: b.last_event_id ?? 0,
        serverNow: b.server_now,
        friends: b.friends ?? [],
        incoming: b.incoming_requests ?? [],
        outgoing: b.outgoing_requests ?? [],
        groups: b.groups ?? [],
        groupInvites: b.group_invites ?? [],
        selectedProjectId: b.projects.find((p: Project) => !p.archived)?.id ?? null
      };
      set({});
      startWsAndSync();
      void store.seedTimezoneFromDevice();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'password_change_required') {
        // forced password change: /me is the only readable surface — surface the
        // flag so App renders the change-password screen instead of the shell
        try {
          const m = await api<{ user: UserProfile }>('/me');
          state = { ...state, booted: true, authed: true, user: m.user };
        } catch {
          state = { ...state, booted: true, authed: false };
        }
        set({});
      } else if (e?.status === 401) {
        state = { ...state, booted: true, authed: false };
        set({});
      } else {
        state = { ...state, booted: true, authed: false };
        set({});
        pushToast('error', 'Could not reach the server — retrying', undefined, 6000);
        // tracked retry: a login during the retry window must not leave two
        // boot loops racing (audit)
        if (bootRetry === null) {
          bootRetry = window.setTimeout(() => { bootRetry = null; void store.boot(); }, 3000);
        }
      }
    }
  },

  setAuthed(v: boolean) { set({ authed: v }); if (v) void store.boot(); },
  /** Session ended (logout, revoke, expiry) → back to the login screen. */
  signOut() {
    try { localStorage.removeItem('tk.device'); } catch { /* storage may be blocked */ }
    state = { ...state, authed: false, user: null, settings: null, projects: [], tasks: [], subtasks: [], deps: [], running: null, pomo: null, recentEntries: [], selectedTaskId: null, friends: [], incoming: [], outgoing: [], friendPresence: {}, groups: [], groupInvites: [] };
    set({});
  },

  // ---------- selection / view ----------
  selectProject(id: string | null) { set({ selectedProjectId: id }); },
  selectTask(id: string | null) {
    const t = state.tasks.find((x) => x.id === id);
    set({ selectedTaskId: id, selectedProjectId: t ? t.project_id : state.selectedProjectId });
  },
  setView(view: AppState['view']) { set({ view }); },
  /** View switch with URL sync: routes are /, /log, /map, /dashboard. */
  navigateToView(view: AppState['view']) { set({ view }); go(pathForView(view)); },

  setConnection(c: AppState['connection']) { set({ connection: c }); },

  /**
   * Timer start with switch-fallback — THE one implementation (audit: this was
   * triplicated across TreeSidebar/App/MapView, and the Map copy dropped the
   * `pomo` payload, leaving pomo UI state stale). Applies setRunning + setPomo;
   * throws for the caller to toast. Stops are not covered (every caller stops
   * differently). `subtaskId` starts (or re-anchors via the switch fallback)
   * the session on a subtask — a same-task switch splits into two attributed
   * sessions.
   */
  async startTimer(taskId: string, subtaskId?: string | null): Promise<void> {
    const body = { task_id: taskId, subtask_id: subtaskId ?? null };
    try {
      const res = await api<{ session: any; pomo?: any }>('/timer/start', { method: 'POST', body });
      store.setRunning(res.session);
      store.markRecentTask(taskId, subtaskId ?? null);
      if (res.pomo) store.setPomo(res.pomo);
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'already_running') {
        const res = await api<{ started: any; pomo?: any }>('/timer/switch', { method: 'POST', body });
        store.setRunning(res.started);
        store.markRecentTask(taskId, subtaskId ?? null);
        if (res.pomo) store.setPomo(res.pomo);
      } else throw e;
    }
  },

  // ---------- event reconciliation (FR-N2/N3) ----------
  applyEvent(ev: WsEvent): void {
    if (ev.actor === getDeviceId()) { state = { ...state, lastEventId: Math.max(state.lastEventId, ev.id) }; set({}); return; }
    const d = ev.data as any;
    const patch: Partial<AppState> = { lastEventId: Math.max(state.lastEventId, ev.id) };
    const upsert = <T extends { id: string }>(arr: T[], item: T): T[] => {
      const i = arr.findIndex((x) => x.id === item.id);
      if (i === -1) return [...arr, item];
      const next = arr.slice();
      next[i] = { ...next[i]!, ...item };
      return next;
    };
    const markRecent = (taskId: string, subtaskId: string | null): RecentEntry[] =>
      mergeRecent(state.recentEntries, taskId, subtaskId);

    switch (ev.type) {
      case 'hello': {
        patch.running = d.running ?? null;
        patch.pomo = d.pomo ?? null;
        patch.connection = 'online';
        break;
      }
      case 'timer.started':
        patch.running = d.session;
        patch.recentEntries = markRecent(d.session.task_id, d.session.subtask_id ?? null);
        patch.reportsVersion = state.reportsVersion + 1;
        break;
      case 'timer.stopped': patch.running = null; patch.reportsVersion = state.reportsVersion + 1; break;
      case 'timer.switched':
        patch.running = d.started;
        patch.recentEntries = markRecent(d.started.task_id, d.started.subtask_id ?? null);
        patch.reportsVersion = state.reportsVersion + 1;
        break;
      case 'timer.nudge': pushToast('info', 'This timer has been running for more than 12 hours'); break;

      case 'session.created': case 'session.updated': patch.reportsVersion = state.reportsVersion + 1; break;
      case 'session.deleted': patch.reportsVersion = state.reportsVersion + 1; break;

      case 'project.created': patch.projects = upsert(state.projects, d.project); break;
      case 'project.updated':
        patch.projects = upsert(state.projects, d.project);
        patch.reportsVersion = state.reportsVersion + 1;
        break;
      case 'project.deleted': {
        const removedIds = new Set<string>((d.tasks ?? []).map((t: Task) => t.id));
        removedIds.add(d.project.id);
        patch.projects = state.projects.filter((p) => p.id !== d.project.id);
        patch.tasks = state.tasks.filter((t) => !removedIds.has(t.id));
        patch.subtasks = state.subtasks.filter((s) => !removedIds.has(s.task_id));
        patch.deps = state.deps.filter((dep) => !removedIds.has(dep.task_id) && !removedIds.has(dep.depends_on_id));
        if (state.selectedProjectId === d.project.id) patch.selectedProjectId = null;
        if (state.selectedTaskId && removedIds.has(state.selectedTaskId)) patch.selectedTaskId = null;
        // the cascade deleted the session rows too — drop a stranded timer
        if (state.running && removedIds.has(state.running.task_id)) patch.running = null;
        if (state.pomo && state.pomo.taskId && removedIds.has(state.pomo.taskId)) patch.pomo = null;
        patch.reportsVersion = state.reportsVersion + 1;
        break;
      }

      case 'task.created': patch.tasks = upsert(state.tasks, d.task); break;
      case 'task.updated': patch.tasks = upsert(state.tasks, d.task); patch.reportsVersion = state.reportsVersion + 1; break;
      case 'task.deleted': {
        const ids = new Set<string>([d.task.id, ...(d.subtasks ?? []).map((s: Subtask) => s.task_id === d.task.id ? s.id : '')]);
        patch.tasks = state.tasks.filter((t) => t.id !== d.task.id);
        patch.subtasks = state.subtasks.filter((s) => s.task_id !== d.task.id);
        patch.deps = state.deps.filter((dep) => dep.task_id !== d.task.id && dep.depends_on_id !== d.task.id);
        if (state.selectedTaskId && ids.has(state.selectedTaskId)) patch.selectedTaskId = null;
        // the cascade deleted the session rows too — drop a stranded timer
        if (state.running && ids.has(state.running.task_id)) patch.running = null;
        if (state.pomo && state.pomo.taskId && ids.has(state.pomo.taskId)) patch.pomo = null;
        patch.reportsVersion = state.reportsVersion + 1;
        break;
      }

      case 'subtask.created': case 'subtask.updated': case 'subtask.toggled':
        patch.subtasks = upsert(state.subtasks, d.subtask);
        break;
      case 'subtask.deleted': patch.subtasks = state.subtasks.filter((s) => s.id !== d.subtask.id); break;

      case 'dependency.created':
        if (!state.deps.some((x) => x.task_id === d.dependency.task_id && x.depends_on_id === d.dependency.depends_on_id))
          patch.deps = [...state.deps, d.dependency];
        break;
      case 'dependency.deleted':
        patch.deps = state.deps.filter((x) => !(x.task_id === d.dependency.task_id && x.depends_on_id === d.dependency.depends_on_id));
        break;

      case 'pomodoro.phase': patch.pomo = d.pomo; break;
      case 'layout.updated':
        // map positions changed on another device — refetch happens in MapView
        // (it listens for this via reportsVersion-style bump on a dedicated
        // event listener below); nothing else depends on layout
        window.dispatchEvent(new CustomEvent('tk:layout-updated', { detail: d }));
        break;
      case 'settings.updated':
        if (d.settings) patch.settings = d.settings;
        if (d.profile) patch.user = state.user ? { ...state.user, ...d.profile } : state.user;
        break;
      case 'import.completed':
      case 'restore.completed':
        // bulk mutation / undo on another device — re-sync everything
        void refreshAll();
        break;
      // social state changes are signals — the small social lists are refetched
      case 'friend.requested': case 'friend.accepted': case 'friend.removed':
        void store.loadSocial();
        break;
      case 'group.created': case 'group.updated': case 'group.deleted':
      case 'group.member_joined': case 'group.member_left': case 'group.member_removed':
      case 'group.member_updated': case 'group.invite_created': case 'group.invite_removed':
        void store.loadGroups();
        break;
      case 'group.message_created': {
        // an open chat panel appends live (custom event); closed panels only
        // need the unread badge, patched locally — no refetch per message
        window.dispatchEvent(new CustomEvent('tk:group-message', { detail: d }));
        if (state.groups.some((g) => g.id === d.group_id)) {
          patch.groups = state.groups.map((g) => g.id === d.group_id ? { ...g, unread: g.unread + 1 } : g);
        }
        break;
      }
      case 'group.message_updated': case 'group.message_deleted':
        window.dispatchEvent(new CustomEvent('tk:group-message', { detail: d }));
        break;
      case 'friend.timer': {
        const p = d.running && d.project && d.task
          ? { project_id: d.project.id, task_id: d.task.id, task_name: d.task.name, started_at: d.started_at }
          : null;
        patch.friendPresence = { ...state.friendPresence, [d.user?.id ?? '']: p };
        break;
      }
      default: break; // unknown event types are ignored gracefully (forward-compat)
    }
    set(patch);
  },

  // ---------- optimistic local helpers (used by the acting device) ----------
  upsertLocal(kind: 'project' | 'task' | 'subtask', item: any) {
    if (kind === 'project') set({ projects: upsertLocalList(state.projects, item) });
    if (kind === 'task') set({ tasks: upsertLocalList(state.tasks, item) });
    if (kind === 'subtask') set({ subtasks: upsertLocalList(state.subtasks, item) });
  },
  removeLocalTask(id: string) {
    set({
      tasks: state.tasks.filter((t) => t.id !== id),
      subtasks: state.subtasks.filter((s) => s.task_id !== id),
      deps: state.deps.filter((d) => d.task_id !== id && d.depends_on_id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
      reportsVersion: state.reportsVersion + 1
    });
  },
  removeLocalProject(id: string) {
    const ids = new Set(state.tasks.filter((t) => t.project_id === id).map((t) => t.id));
    ids.add(id);
    set({
      projects: state.projects.filter((p) => p.id !== id),
      tasks: state.tasks.filter((t) => t.project_id !== id),
      subtasks: state.subtasks.filter((s) => !ids.has(s.task_id)),
      deps: state.deps.filter((d) => !ids.has(d.task_id) && !ids.has(d.depends_on_id)),
      selectedProjectId: state.selectedProjectId === id ? null : state.selectedProjectId,
      selectedTaskId: state.selectedTaskId && ids.has(state.selectedTaskId) ? null : state.selectedTaskId,
      reportsVersion: state.reportsVersion + 1
    });
  },
  removeLocalSubtask(id: string) { set({ subtasks: state.subtasks.filter((s) => s.id !== id) }); },
  upsertDep(dep: Dependency) {
    if (!state.deps.some((x) => x.task_id === dep.task_id && x.depends_on_id === dep.depends_on_id))
      set({ deps: [...state.deps, dep] });
  },
  removeDep(taskId: string, dependsOnId: string) {
    set({ deps: state.deps.filter((d) => !(d.task_id === taskId && d.depends_on_id === dependsOnId)) });
  },
  setRunning(session: RunningSession | null) { set({ running: session, reportsVersion: state.reportsVersion + 1 }); },
  markRecentTask(id: string, subtaskId: string | null = null) {
    set({ recentEntries: mergeRecent(state.recentEntries, id, subtaskId) });
  },
  setPomo(pomo: PomoState | null) { set({ pomo }); },
  setSettings(s: Settings) { set({ settings: s }); },
  setUser(u: UserProfile) { set({ user: u }); },
  /**
   * Seed the profile timezone from the device (the manual-timeslot tz fix).
   * Every admin-created user starts with the seeded 'UTC' (routes/admin.ts) and
   * nothing else ever sets it — so reports, the log and the session editor all
   * bucket/display in UTC while the user lives elsewhere. Rule: ONLY the
   * untouched 'UTC' default is auto-corrected, and only to a different, valid
   * device zone. A zone the user picked (any non-'UTC' value, including a
   * deliberate 'UTC') is respected. Idempotent: after the PATCH the profile
   * equals the device zone and this is a no-op.
   */
  async seedTimezoneFromDevice(): Promise<void> {
    const user = state.user;
    const deviceTz = deviceTimezone();
    if (!user || !deviceTz || user.timezone === deviceTz || user.timezone !== 'UTC') return;
    try {
      const res = await api<{ user: any }>('/me', { method: 'PATCH', body: { timezone: deviceTz } });
      store.setUser(res.user);
      store.bumpReports(); // day buckets moved → refetch charts
      pushToast('info', `Timezone set to ${deviceTz} (from this device) — change it any time in Settings`);
    } catch { /* non-fatal: stays UTC; Settings offers a one-click device-zone button */ }
  },
  bumpReports() { set({ reportsVersion: state.reportsVersion + 1 }); },
  tickServerNow() { set({ serverNow: Date.now() }); },

  // ---------- social ----------
  /** Refetch friends + pending requests (after a social event or a local mutation). */
  loadSocial: async () => {
    try {
      const res = await api<any>('/friends');
      set({ friends: res.friends ?? [], incoming: res.incoming ?? [], outgoing: res.outgoing ?? [] });
    } catch { /* offline — keep the last lists */ }
  },
  /** Merge one-shot presence results (POST /friends/presence). */
  setFriendPresence(map: Record<string, FriendPresence | null>) {
    set({ friendPresence: { ...state.friendPresence, ...map } });
  },
  /** Refetch groups + pending group invites. */
  loadGroups: async () => {
    try {
      const res = await api<any>('/groups');
      set({ groups: res.groups ?? [], groupInvites: res.incoming_invites ?? [] });
    } catch { /* offline — keep the last lists */ }
  },
  /** The chat panel for this group is open and caught up — clear its badge. */
  markGroupRead(groupId: string) {
    set({ groups: state.groups.map((g) => g.id === groupId ? { ...g, unread: 0 } : g) });
  },

  refreshAll: async () => refreshAll()
};

function upsertLocalList<T extends { id: string }>(arr: T[], item: T): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i === -1) return [...arr, item];
  const next = arr.slice();
  next[i] = { ...next[i]!, ...item };
  return next;
}

// ---------- toasts (incl. 5-second undo, FR-T4) ----------

let toastSeq = 1;
export function pushToast(kind: Toast['kind'], message: string, undoPayload?: () => Promise<unknown>, ttlMs = 5000): void {
  const t: Toast = { id: toastSeq++, kind, message, undoPayload, until: Date.now() + ttlMs };
  set({ toasts: [...state.toasts, t] });
  setTimeout(() => {
    set({ toasts: state.toasts.filter((x) => x.id !== t.id) });
  }, ttlMs);
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

// ---------- undo helper: deletes return their payload; undo re-inserts identical rows ----------

export function undoableDelete(message: string, undoPayload: unknown): void {
  // large deletes restore row-by-row collections server-side — give a bigger
  // window than the default 5 s toast
  const rows = undoPayload && typeof undoPayload === 'object'
    ? Object.values(undoPayload as Record<string, unknown[]>)
      .reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0)
    : 0;
  const ttl = rows > 1000 ? 20_000 : 5000;
  pushToast('undo', message, async () => {
    await api('/restore', { method: 'POST', body: undoPayload });
    await store.refreshAll();
  }, ttl);
}

export async function refreshAll(): Promise<void> {
  const b = await api<any>('/bootstrap');
  set({
    user: b.user, settings: b.settings, projects: b.projects, tasks: b.tasks,
    subtasks: b.subtasks, deps: b.dependencies, recentEntries: recentFromBootstrap(b),
    friends: b.friends ?? [], incoming: b.incoming_requests ?? [], outgoing: b.outgoing_requests ?? [],
    groups: b.groups ?? [], groupInvites: b.group_invites ?? [],
    running: b.running ?? null,
    pomo: b.pomo ?? null, lastEventId: b.last_event_id ?? 0, reportsVersion: state.reportsVersion + 1
  });
}

// ---------- react binding ----------

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}

// ---------- URL routing ----------

/** Push a path and notify the router (popstate listener in App). */
export function go(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function pathForView(view: AppState['view']): string {
  return view === 'tree' ? '/' : `/${view}`;
}

/** URL path → view; null for non-view routes (/login, /reset, /settings…). */
export function viewFromPath(path: string): AppState['view'] | null {
  if (path === '/' || path === '') return 'tree';
  if (path === '/log' || path === '/map' || path === '/dashboard' || path === '/social') {
    return path.slice(1) as AppState['view'];
  }
  return null;
}

// ---------- websocket wiring (FR-N1/N5) + reconciliation polling (FR-N3) ----------
//
// Two layers run concurrently:
//  - the WebSocket is retried with backoff forever — a failed first connect
//    downgrades to polling only until the next attempt succeeds;
//  - a low-frequency reconciliation poll runs even while the socket is healthy,
//    so dropped DO notifications can only make a device stale for one cadence.

let ws: WebSocket | null = null;
let pollTimer: number | null = null;
let pollCadence = 0;
let backoff = 1000;
let wsRetryTimer: number | null = null;

function connectWs(): void {
  if (ws) return; // a socket is already open or connecting
  try {
    const socket = new WebSocket(wsUrl());
    ws = socket;
    socket.onopen = () => {
      backoff = 1000;
      // socket healthy — drop to a slow reconcile cadence
      startPolling(60_000);
      store.setConnection('online');
    };
    socket.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data as string) as WsEvent & { type: string };
        if ((ev.type as string) === 'pong') return;
        store.applyEvent(ev as WsEvent);
      } catch { /* malformed frame ignored */ }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      store.setConnection('reconnecting');
      scheduleReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* already closing */ }
    };
    // if this connection cannot establish (proxy), poll while the socket keeps
    // retrying in the background — no permanent downgrade
    setTimeout(() => {
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
        startPolling(30_000);
        scheduleReconnect();
      }
    }, 5000);
  } catch {
    startPolling(30_000);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (wsRetryTimer !== null || ws) return;
  wsRetryTimer = window.setTimeout(() => {
    wsRetryTimer = null;
    backoff = Math.min(backoff * 2, 15_000);
    connectWs();
  }, backoff);
}

function startPolling(cadenceMs: number): void {
  if (pollTimer !== null && pollCadence === cadenceMs) return;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollCadence = cadenceMs;
  pollTimer = window.setInterval(poll, cadenceMs);
  void poll();
}

const SYNC_PAGE = LIMITS.syncPageMax; // server-side limit of GET /api/sync

const poll = async (): Promise<void> => {
  try {
    const res = await api<any>(`/sync?since=${state.lastEventId}`);
    const events = res.events ?? [];
    for (const ev of events) store.applyEvent(ev);
    // drain a full page immediately — a burst can exceed the cap and leave
    // polling clients one page per cadence behind
    for (let drained = 0; events.length === SYNC_PAGE && drained < 20; drained++) {
      const more = await api<any>(`/sync?since=${state.lastEventId}`);
      const list = more.events ?? [];
      for (const ev of list) store.applyEvent(ev);
      if (list.length < SYNC_PAGE) break;
    }
    if (!ws) {
      if (res.running !== undefined
          && JSON.stringify(res.running) !== JSON.stringify(state.running)) store.setRunning(res.running);
      if (res.pomo) store.setPomo(res.pomo);
      store.setConnection('online'); // polling path works — not offline
    }
  } catch {
    if (!ws) store.setConnection('offline'); // fully offline: mutations blocked with a banner (FR-N5)
  }
};

// Reconcile as soon as the tab becomes visible again — catches anything missed
// while backgrounded (dropped notifies, suspended timers).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.booted && state.authed) void poll();
  });
  // Global session-expiry handling (audit): any 401 outside the auth endpoints
  // ends the session instead of toasting forever.
  window.addEventListener('tk:unauthorized', () => {
    if (state.authed) store.signOut();
  });
}

/** Entry point after boot: start the socket and the reconcile loop together. */
function startWsAndSync(): void {
  connectWs();
  startPolling(60_000);
}
