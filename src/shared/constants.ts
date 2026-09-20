// Product-wide constants: limits (NFR-2), defaults (FR-C2), palette (FR-P2), event catalog (FR-N2).

export const LIMITS = {
  projectsActive: 200,
  tasksPerUser: 5_000,
  subtasksPerTask: 100,
  sessionsPerUser: 200_000,
  nameMax: 120,
  noteMax: 2_000,
  logPageSize: 200,
  // Max events returned by GET /sync per page (client drains full pages).
  syncPageMax: 500,
  // Total-row cap for /restore (undo). Sized to cover the largest possible
  // legitimate delete payload: 200 projects + 5000 tasks + 500k subtasks
  // (100/task) + 500k dependencies + 200k sessions.
  restoreMaxRows: 1_250_000
} as const;

/** Password policy minimum (mirrored client-side — do not hardcode). */
export const MIN_PASSWORD = 10;

/** Hard cap on report date ranges in civil days (a wider from/to is a 422, not a silent truncation). */
export const REPORT_MAX_RANGE_DAYS = 1500;

export const POMODORO_DEFAULTS = {
  focusMin: 25,   // 5–90 (FR-F5)
  breakMin: 5,    // 1–30
  autoStart: false
} as const;

export const POMODORO_LIMITS = { focusMinMin: 5, focusMinMax: 90, breakMinMin: 1, breakMinMax: 30 } as const;

export const SESSION_RULES = {
  /** start may not be more than 5 minutes in the future (§5.5.4) */
  futureToleranceMs: 5 * 60_000,
  /** recovery "Discard" default grace (FR-S3) */
  graceMin: 15
} as const;

export const SESSION_COOKIE = 'tk_session';
export const CSRF_COOKIE = 'tk_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const DEVICE_HEADER = 'x-device-id';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;      // 30 days (FR-A6)
export const SESSION_ROTATE_BEFORE_MS = 7 * 24 * 3600_000; // rotate when < 7 days left

/** 12 accessible accent colors (FR-P2) — checked for ≥3:1 on both themes for non-text use. */
export const PALETTE = [
  '#4f8cff', '#22c55e', '#f97316', '#a855f7', '#06b6d4', '#ef4444',
  '#eab308', '#ec4899', '#84cc16', '#14b8a6', '#8b5cf6', '#f43f5e'
] as const;

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** WebSocket event catalog (spec §5.4) — plus 'timer.nudge' (>12h failsafe, never auto-stops). */
export const EVENT_TYPES = [
  'hello',
  'timer.started', 'timer.stopped', 'timer.switched', 'timer.nudge',
  'session.created', 'session.updated', 'session.deleted',
  'task.created', 'task.updated', 'task.deleted',
  'subtask.created', 'subtask.updated', 'subtask.deleted', 'subtask.toggled',
  'project.created', 'project.updated', 'project.deleted',
  'dependency.created', 'dependency.deleted',
  'pomodoro.phase',
  'settings.updated',
  'layout.updated',
  'import.completed',
  'restore.completed'
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface WsEvent<T = unknown> {
  id: number;              // sync_log id (cursor for ?since=)
  type: EventType;
  actor: string;           // device id of the originating tab (clients ignore own echoes)
  at: number;              // epoch ms
  data: T;
}

export const EXPORT_SCHEMA_VERSION = 1;
