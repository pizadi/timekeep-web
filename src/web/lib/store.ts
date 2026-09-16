// Global store: bootstrap state, idempotent WS/poll event reconciliation
// (last-write-wins at entity level, FR-N3), undo toasts, reports invalidation.
import { useSyncExternalStore } from 'react';
import type { WsEvent } from '../../shared/constants';
import { api, getDeviceId, wsUrl, ApiError } from './api';

export interface Project { id: string; name: string; color: string; archived: 0 | 1; position: number; created_at: number; updated_at: number }
export interface Task { id: string; project_id: string; parent_id: string | null; name: string; notes: string; done: 0 | 1; position: number; created_at: number; updated_at: number }
export interface Subtask { id: string; task_id: string; name: string; done: 0 | 1; position: number; created_at: number }
export interface Dependency { task_id: string; depends_on_id: string; created_at: number }
export interface SessionRow { id: string; task_id: string; started_at: number; ended_at: number | null; source: 'timer' | 'manual' | 'pomodoro'; note: string; created_at: number; updated_at: number }
export interface RunningSession { id: string; task_id: string; started_at: number; source: string; ended_at?: null }
export interface PomoState {
  phase: 'idle' | 'focus' | 'decide' | 'break' | 'ready';
  taskId: string | null;
  focus_ms_live: number; focus_goal_ms: number;
  break_ms_left: number | null; break_ms_total: number;
  server_now?: number;
}
export interface Settings {
  pomodoro: { focus_min: number; break_min: number; auto_start: boolean };
  grace_min: number;
  notifications_enabled: boolean;
  sound_enabled: boolean;
  theme: 'system' | 'light' | 'dark';
}
export interface UserProfile {
  id: string; username: string; email: string; name: string; timezone: string;
  week_start: 0 | 1; theme: 'system' | 'light' | 'dark';
  role: 'user' | 'admin';
  must_change_password: boolean;
  email_verified_at: number | null; created_at: number;
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
  devices: number;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  view: 'tree' | 'log' | 'map' | 'dashboard';
  reportsVersion: number;      // bumped on relevant events → charts refetch (FR-R5)
  toasts: Toast[];
  lastEventId: number;
  serverNow: number;
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
  devices: 0,
  selectedProjectId: null,
  selectedTaskId: null,
  view: 'tree',
  reportsVersion: 0,
  toasts: [],
  lastEventId: 0,
  serverNow: Date.now()
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const store = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },

  // ---------- bootstrap ----------
  async boot(): Promise<void> {
    try {
      const b = await api<any>('/bootstrap');
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
        running: b.running ?? null,
        pomo: b.pomo ?? null,
        lastEventId: b.last_event_id ?? 0,
        serverNow: b.server_now,
        selectedProjectId: b.projects.find((p: Project) => !p.archived)?.id ?? null
      };
      set({});
      connectWs();
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
        setTimeout(() => store.boot(), 3000);
      }
    }
  },

  setAuthed(v: boolean) { set({ authed: v }); if (v) void store.boot(); },

  // ---------- selection / view ----------
  selectProject(id: string | null) { set({ selectedProjectId: id }); },
  selectTask(id: string | null) {
    const t = state.tasks.find((x) => x.id === id);
    set({ selectedTaskId: id, selectedProjectId: t ? t.project_id : state.selectedProjectId });
  },
  setView(view: AppState['view']) { set({ view }); },

  setConnection(c: AppState['connection']) { set({ connection: c }); },
  setDevices(n: number) { set({ devices: n }); },

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

    switch (ev.type) {
      case 'hello': {
        patch.running = d.running ?? null;
        patch.pomo = d.pomo ?? null;
        patch.devices = d.devices ?? 0;
        patch.connection = 'online';
        break;
      }
      case 'timer.started': patch.running = d.session; patch.reportsVersion = state.reportsVersion + 1; break;
      case 'timer.stopped': patch.running = null; patch.reportsVersion = state.reportsVersion + 1; break;
      case 'timer.switched': patch.running = d.started; patch.reportsVersion = state.reportsVersion + 1; break;
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
      case 'settings.updated':
        if (d.settings) patch.settings = d.settings;
        if (d.profile) patch.user = state.user ? { ...state.user, ...d.profile } : state.user;
        break;
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
  setPomo(pomo: PomoState | null) { set({ pomo }); },
  setSettings(s: Settings) { set({ settings: s }); },
  setUser(u: UserProfile) { set({ user: u }); },
  bumpReports() { set({ reportsVersion: state.reportsVersion + 1 }); },
  tickServerNow() { set({ serverNow: Date.now() }); },
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
  pushToast('undo', message, async () => {
    await api('/restore', { method: 'POST', body: undoPayload });
    await store.refreshAll();
  });
}

export async function refreshAll(): Promise<void> {
  const b = await api<any>('/bootstrap');
  set({
    user: b.user, settings: b.settings, projects: b.projects, tasks: b.tasks,
    subtasks: b.subtasks, deps: b.dependencies, running: b.running ?? null,
    pomo: b.pomo ?? null, lastEventId: b.last_event_id ?? 0, reportsVersion: state.reportsVersion + 1
  });
}

// ---------- react binding ----------

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}

// ---------- websocket wiring (FR-N1/N5) ----------

let ws: WebSocket | null = null;
let pollTimer: number | null = null;
let backoff = 1000;
let wsFailed = false;

export function connectWs(): void {
  if (wsFailed) { startPolling(); return; }
  try {
    const socket = new WebSocket(wsUrl());
    ws = socket;
    socket.onopen = () => {
      backoff = 1000;
      wsFailed = false;
      stopPolling();
      store.setConnection('online');
    };
    socket.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data as string) as WsEvent & { type: string };
        if ((ev.type as string) === 'pong') return;
        store.applyEvent(ev as WsEvent);
        if (ev.type === 'hello') {
          store.setDevices((ev.data as any)?.devices ?? 0);
        }
      } catch { /* malformed frame ignored */ }
    };
    socket.onclose = () => {
      ws = null;
      store.setConnection('reconnecting');
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 15_000);
        connectWs();
      }, backoff);
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* already closing */ }
    };
    // if the first connection cannot establish (proxy), fall back to polling (FR-N5)
    setTimeout(() => {
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
        wsFailed = true;
        startPolling();
      }
    }, 5000);
  } catch {
    wsFailed = true;
    startPolling();
  }
}

function startPolling(): void {
  if (pollTimer !== null) return;
  store.setConnection('offline');
  const poll = async () => {
    try {
      const res = await api<any>(`/sync?since=${state.lastEventId}`);
      for (const ev of res.events ?? []) store.applyEvent(ev);
      if (res.running !== undefined && !ws) {
        // keep the running-timer view correct under polling (30 s cadence, FR-N5 AC)
        if (JSON.stringify(res.running) !== JSON.stringify(state.running)) store.setRunning(res.running);
      }
      if (res.pomo && !ws) store.setPomo(res.pomo);
      store.setConnection(state.lastEventId === 0 && !(res.events ?? []).length ? 'online' : 'online');
    } catch {
      store.setConnection('offline'); // fully offline: mutations blocked with a banner (FR-N5)
    }
  };
  void poll();
  pollTimer = window.setInterval(poll, 30_000);
}

function stopPolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}
