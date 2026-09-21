// Zod schemas — every request body validated server-side (NFR-3).
import { z } from 'zod';
import { GROUP_PERMS, HEX_COLOR_RE, LIMITS, POMODORO_LIMITS } from '../shared/constants';

// Uppercase-only, matching isUlid() in shared/ids.ts (ids are generated uppercase).
export const ulidish = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid id');

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
  position: z.number().int().optional(),
  visibility: z.enum(['private', 'friends']).optional()
});

// Social: friend requests are addressed by username (login identifier).
export const friendRequestSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE,
    'username must be 2–32 chars: lowercase letters, digits, dot, dash, underscore')
});

// Social: groups. perms is a de-duplicated subset of the GROUP_PERMS catalog.
export const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  color: z.string().regex(HEX_COLOR_RE).optional()
});
export const groupPatchSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax).optional(),
  color: z.string().regex(HEX_COLOR_RE).optional()
});
export const groupInviteSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE,
    'username must be 2–32 chars: lowercase letters, digits, dot, dash, underscore')
});
export const groupMemberPatchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),   // owner is not assignable
  perms: z.array(z.enum(GROUP_PERMS)).max(GROUP_PERMS.length).optional()
});
export const groupLinkCreateSchema = z.object({
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
  max_uses: z.number().int().min(1).max(10_000).nullable().optional()
});

// Social: group chat. Body capped like task notes (LIMITS.noteMax).
export const messageCreateSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.noteMax)
});
export const messagePatchSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.noteMax)
});
export const readMarkSchema = z.object({
  at: z.number().int().min(0).max(4_102_444_800_000).optional()   // clamp: [0, 2100]
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

// Manual sessions are always closed intervals: an open-ended (ended_at NULL) row
// is the *running* session, owned exclusively by the timer authority (UserHub DO);
// allowing null here would collide with the partial unique index
// idx_sessions_running.
export const sessionCreateSchema = z.object({
  task_id: ulidish,
  started_at: z.number().int(),
  ended_at: z.number().int(),
  note: z.string().max(LIMITS.noteMax).optional().default(''),
  source: z.enum(['manual']).optional().default('manual')
});

export const sessionPatchSchema = z.object({
  task_id: ulidish.optional(),
  started_at: z.number().int().optional(),
  ended_at: z.number().int().optional(),
  note: z.string().max(LIMITS.noteMax).optional()
});

export const settingsSchema = z.object({
  pomodoro: z.object({
    enabled: z.boolean(),
    focus_min: z.number().int().min(POMODORO_LIMITS.focusMinMin).max(POMODORO_LIMITS.focusMinMax),
    break_min: z.number().int().min(POMODORO_LIMITS.breakMinMin).max(POMODORO_LIMITS.breakMinMax),
    auto_start: z.boolean()
  }).partial().optional(),
  grace_min: z.number().int().min(0).max(240).optional(),
  notifications_enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional()
});

// ---------- import / restore row schemas (audit S3: no more z.any()) ----------
// The import/restore collections are validated row-by-row with these schemas;
// a row that fails is SKIPPED (counted in the summary), never a 500. Cross-row
// rules (parent-is-root, same-project deps/parents, in-file references) are
// enforced in routes/export.ts against the parsed rows.

const boolInt = z.union([z.boolean(), z.number(), z.string()])
  .transform((v) => (v === true || v === 1 || v === '1' ? 1 : 0))
  .catch(0);
const finiteInt = (d: number) => z.number().int().finite().catch(d);

export const importProjectRow = z.object({
  id: z.string().min(1).max(64),
  name: z.string().catch('Imported'),
  color: z.string().max(7).nullable().catch(null),
  archived: boolInt,
  position: finiteInt(0),
  created_at: finiteInt(0)
});

export const importTaskRow = z.object({
  id: z.string().min(1).max(64),
  project_id: ulidish,
  parent_id: ulidish.nullable().catch(null),
  name: z.string().catch('Task'),
  notes: z.string().catch(''),
  done: boolInt,
  position: finiteInt(0),
  created_at: finiteInt(0)
});

export const importSubtaskRow = z.object({
  id: z.string().min(1).max(64),
  task_id: ulidish,
  name: z.string().catch('Subtask'),
  done: boolInt,
  position: finiteInt(0),
  created_at: finiteInt(0)
});

export const importDependencyRow = z.object({
  task_id: ulidish,
  depends_on_id: ulidish,
  created_at: finiteInt(0)
});

// Sessions: started_at must be a real instant; ended_at may be NULL (the undo
// payload of a deleted task legitimately contains the open running session —
// restore re-closes it at restore-time). Duration/future checks live in the
// routes because the two paths differ (import skips, restore re-closes).
export const importSessionRow = z.object({
  id: ulidish,
  task_id: ulidish,
  started_at: z.number().int().finite(),
  ended_at: z.number().int().finite().nullable(),
  note: z.string().max(LIMITS.noteMax).catch(''),
  source: z.enum(['timer', 'manual', 'pomodoro']).catch('manual'),
  created_at: finiteInt(0)
});

// ---------- undo payloads (FR-T4) ----------

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
    // rows are validated per-item inside routes/export.ts (importXxxRow schemas) —
    // a bad row is SKIPPED and counted, matching the documented import semantics;
    // validating them here would fail the whole file on one bad row
    projects: z.array(z.any()).max(LIMITS.projectsActive * 2).default([]),
    tasks: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    subtasks: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    dependencies: z.array(z.any()).max(LIMITS.tasksPerUser * 2).default([]),
    sessions: z.array(z.any()).max(LIMITS.sessionsPerUser).default([]),
    settings: z.record(z.any()).optional()
  })
});

// Undo payloads (FR-T4) are produced by delete routes, so the caps here must
// cover the *largest possible legitimate delete*: a project with 5000 tasks,
// up to 100 subtasks each, and 200k sessions. The total-row guard uses
// LIMITS.restoreMaxRows, sized to cover those maxima combined.
const RESTORE_COLLECTION_MAX = LIMITS.subtasksPerTask * LIMITS.tasksPerUser;

export const restoreSchema = z.object({
  projects: z.array(importProjectRow).max(LIMITS.projectsActive).default([]),
  tasks: z.array(importTaskRow).max(LIMITS.tasksPerUser).default([]),
  subtasks: z.array(importSubtaskRow).max(RESTORE_COLLECTION_MAX).default([]),
  dependencies: z.array(importDependencyRow).max(RESTORE_COLLECTION_MAX).default([]),
  sessions: z.array(importSessionRow).max(LIMITS.sessionsPerUser).default([])
}).superRefine((d, ctx) => {
  const total = d.projects.length + d.tasks.length + d.subtasks.length
    + d.dependencies.length + d.sessions.length;
  if (total > LIMITS.restoreMaxRows) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `restore payload exceeds ${LIMITS.restoreMaxRows} total rows` });
  }
});

export const pomoStartSchema = z.object({ task_id: ulidish.optional() });
