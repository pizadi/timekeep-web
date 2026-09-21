// Group access control (social phase 2): one loader, one permission check.
// Every group route resolves membership through here so the authorization
// matrix lives in exactly one place. Ownership checks follow the codebase's
// scoped-SQL posture; a non-member gets 404 (a group they can't see does not
// exist), a member lacking a permission gets 403.
import type { Env } from './env';
import { GROUP_PERMS, type GroupPerm } from '../shared/constants';
import { RuleError } from './rules';

export interface GroupRow {
  id: string; name: string; color: string; owner_id: string;
  created_at: number; updated_at: number;
}

export interface GroupMemberRow {
  group_id: string; user_id: string;
  role: 'owner' | 'admin' | 'member';
  perms: string;           // raw JSON column ('' = none)
  last_read_at: number;
  created_at: number;
}

export interface GroupContext {
  group: GroupRow;
  member: GroupMemberRow;
  role: 'owner' | 'admin' | 'member';
  perms: Set<GroupPerm>;
}

export function parsePerms(raw: string): Set<GroupPerm> {
  const out = new Set<GroupPerm>();
  if (!raw) return out;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const p of arr) if (GROUP_PERMS.includes(p)) out.add(p);
  } catch { /* corrupt column = no perms (fail closed) */ }
  return out;
}

/** Resolve the caller's group context, or null when not a member. */
export async function loadGroupContext(env: Env, groupId: string, userId: string): Promise<GroupContext | null> {
  const group = await env.DB.prepare(
    'SELECT id, name, color, owner_id, created_at, updated_at FROM groups WHERE id = ?1'
  ).bind(groupId).first<GroupRow>();
  if (!group) return null;
  const member = await env.DB.prepare(
    'SELECT group_id, user_id, role, perms, last_read_at, created_at FROM group_members WHERE group_id = ?1 AND user_id = ?2'
  ).bind(groupId, userId).first<GroupMemberRow>();
  if (!member) return null;
  const perms = parsePerms(member.perms);
  if (member.role === 'owner') for (const p of GROUP_PERMS) perms.add(p);
  return { group, member, role: member.role, perms };
}

/** Members-only gate: 404 when the group doesn't exist or the caller isn't in it. */
export async function requireGroup(env: Env, groupId: string, userId: string): Promise<GroupContext> {
  const ctx = await loadGroupContext(env, groupId, userId);
  if (!ctx) throw new RuleError(404, 'not_found', 'group not found');
  return ctx;
}

/** Members-only + permission gate: 404 for outsiders, 403 for under-privileged members. */
export async function requireGroupPerm(env: Env, groupId: string, userId: string, perm: GroupPerm): Promise<GroupContext> {
  const ctx = await requireGroup(env, groupId, userId);
  if (!ctx.perms.has(perm)) throw new RuleError(403, 'forbidden', `missing permission: ${perm}`);
  return ctx;
}
