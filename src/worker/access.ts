// Group-project access (social phase 4, feature 6): one resolver that every
// project/task route uses instead of a bare `WHERE user_id = ?`.
//
//   personal project  (group_id IS NULL) — user_id is the owner; full control.
//   group project     (group_id set)     — visible to every CURRENT member;
//                       structure edits gate on the per-member perms:
//                       'edit_tasks' for tasks, 'manage_projects' for the
//                       project itself. Row user_id stays the CREATOR (audit).
//
// Sessions stay strictly user-owned everywhere — tracking on a shared task
// writes YOUR session row, so the single-timer invariant and personal reports
// are unaffected. Leaving a group (or being removed) revokes access instantly
// because every check re-resolves membership; deleting the group cascades the
// projects.
import type { Env } from './env';
import { loadGroupContext } from './group-auth';
import { RuleError } from './rules';

export interface ProjectAccess {
  project: Record<string, unknown> & { id: string; user_id: string; group_id: string | null; archived: 0 | 1 };
  isGroup: boolean;
  /** create/edit/delete tasks, subtasks and dependency edges inside */
  canEditTasks: boolean;
  /** rename/recolor/archive/delete the project itself */
  canManage: boolean;
}

export async function resolveProjectAccess(env: Env, userId: string, projectId: string): Promise<ProjectAccess | null> {
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(projectId).first<any>();
  if (!p) return null;
  if (!p.group_id) {
    if (p.user_id !== userId) return null; // personal project of someone else
    return { project: p, isGroup: false, canEditTasks: true, canManage: true };
  }
  const ctx = await loadGroupContext(env, p.group_id, userId);
  if (!ctx) return null; // not a (current) member — the project does not exist for them
  return {
    project: p,
    isGroup: true,
    canEditTasks: ctx.perms.has('edit_tasks'),
    canManage: ctx.perms.has('manage_projects'),
  };
}

export async function resolveTaskAccess(
  env: Env,
  userId: string,
  taskId: string,
): Promise<{
  task: Record<string, unknown> & { id: string; user_id: string; project_id: string };
  access: ProjectAccess;
} | null> {
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(taskId).first<any>();
  if (!t) return null;
  const access = await resolveProjectAccess(env, userId, t.project_id);
  if (!access) return null;
  return { task: t, access };
}

/** Throwing variants for route handlers (404 semantics: not visible = gone). */
export async function requireProjectAccess(env: Env, userId: string, projectId: string): Promise<ProjectAccess> {
  const a = await resolveProjectAccess(env, userId, projectId);
  if (!a) throw new RuleError(404, 'not_found', 'project not found');
  return a;
}

export async function requireTaskAccess(env: Env, userId: string, taskId: string) {
  const r = await resolveTaskAccess(env, userId, taskId);
  if (!r) throw new RuleError(404, 'not_found', 'task not found');
  return r;
}

/** Throws unless the viewer may edit structure inside this project. */
export async function requireEditTasks(env: Env, userId: string, projectId: string) {
  const a = await requireProjectAccess(env, userId, projectId);
  if (!a.canEditTasks) throw new RuleError(403, 'forbidden', 'missing permission: edit_tasks');
  return a;
}
