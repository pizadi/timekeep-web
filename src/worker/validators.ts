// Zod schemas — every request body validated server-side (NFR-3).
import { z } from 'zod';
import { HEX_COLOR_RE, LIMITS, POMODORO_LIMITS } from '../shared/constants';

export const ulidish = z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/, 'invalid id');

// Login identifier: username (canonical) or legacy email. Lowercased.
export const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200),
  turnstile: z.string().max(4096).optional()
});

// Username: 2–32 chars, lowercase alnum + . _ - (no '@' — that means email).
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const passwordChangeSchema = z.object({
  current_password: z.string().min(1).max(200),
  password: z.string().min(10).max(200)
});

// Admin user management (no self-signup anywhere — admin creates accounts).
export const adminCreateSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE,
    'username must be 2–32 chars: lowercase letters, digits, dot, dash, underscore'),
  name: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().toLowerCase().max(254).optional(),
  password: z.string().min(10).max(200)
});
export const adminPatchSchema = z.object({
  active: z.union([z.literal(0), z.literal(1)])
});
export const adminResetSchema = z.object({
  password: z.string().min(10).max(200)
});

export const verifyEmailSchema = z.object({ token: z.string().min(16).max(256) });
export const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().max(254), turnstile: z.string().max(4096).optional() });
export const resetConfirmSchema = z.object({ token: z.string().min(16).max(256), password: z.string().min(10).max(200) });

export const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64).optional(),
  week_start: z.number().int().min(0).max(6).optional(), // 0=Sun … 6=Sat
  theme: z.enum(['system', 'light', 'dark']).optional()
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  color: z.string().regex(HEX_COLOR_RE).optional(),
  position: z.number().int().optional()
});

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  color: z.string().regex(HEX_COLOR_RE).optional(),
  archived: z.boolean().optional(),
  position: z.number().int().optional()
});

export const reorderSchema = z.object({ ids: z.array(z.string()).max(LIMITS.projectsActive).optional() });

export const taskCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  notes: z.string().max(LIMITS.noteMax).optional()
});

export const taskPatchSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  notes: z.string().max(LIMITS.noteMax).optional(),
  done: z.boolean().optional(),
  position: z.number().int().optional(),
  project_id: ulidish.optional()
});

export const subtaskCreateSchema = z.object({ name: z.string().trim().min(1).max(LIMITS.nameMax) });
export const subtaskPatchSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  done: z.boolean().optional(),
  position: z.number().int().optional()
});

export const depCreateSchema = z.object({ depends_on_id: ulidish });

export const sessionCreateSchema = z.object({
  task_id: ulidish,
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  note: z.string().max(LIMITS.noteMax).optional().default(''),
  source: z.enum(['manual']).optional().default('manual')
});

export const sessionPatchSchema = z.object({
  task_id: ulidish.optional(),
  started_at: z.number().int().optional(),
  ended_at: z.number().int().nullable().optional(),
  note: z.string().max(LIMITS.noteMax).optional()
});

export const settingsSchema = z.object({
  pomodoro: z.object({
    focus_min: z.number().int().min(POMODORO_LIMITS.focusMinMin).max(POMODORO_LIMITS.focusMinMax),
    break_min: z.number().int().min(POMODORO_LIMITS.breakMinMin).max(POMODORO_LIMITS.breakMinMax),
    auto_start: z.boolean()
  }).partial().optional(),
  grace_min: z.number().int().min(0).max(240).optional(),
  notifications_enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional()
});

export const layoutSchema = z.object({
  positions: z.array(z.object({
    task_id: ulidish,
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000)
  })).max(LIMITS.tasksPerUser)
});

export const importSchema = z.object({
  mode: z.enum(['merge', 'duplicate']),
  data: z.object({
    schema_version: z.number().int().optional(),
    projects: z.array(z.any()).max(LIMITS.projectsActive * 2).default([]),
    tasks: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    subtasks: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    dependencies: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    sessions: z.array(z.any()).max(LIMITS.sessionsPerUser).default([]),
    settings: z.record(z.any()).optional()
  })
});

export const restoreSchema = z.object({
  projects: z.array(z.any()).max(LIMITS.projectsActive).default([]),
  tasks: z.array(z.any()).max(2000).default([]),
  subtasks: z.array(z.any()).max(5000).default([]),
  dependencies: z.array(z.any()).max(5000).default([]),
  sessions: z.array(z.any()).max(5000).default([])
});

export const pomoStartSchema = z.object({ task_id: ulidish.optional() });
