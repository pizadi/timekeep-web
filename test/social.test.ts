// Social layer pure logic: permission parsing (fail-closed), the group perm
// validator subset, and message/body caps. No DB, no network.
import { describe, it, expect } from 'vitest';
import { parsePerms } from '../src/worker/group-auth';
import {
  groupMemberPatchSchema, messageCreateSchema, friendRequestSchema,
  groupCreateSchema, groupLinkCreateSchema, readMarkSchema
} from '../src/worker/validators';
import { GROUP_PERMS } from '../src/shared/constants';

describe('group permission parsing (worker/group-auth.parsePerms)', () => {
  it('parses a JSON array into a set, ignoring unknown keys', () => {
    const perms = parsePerms(JSON.stringify(['edit_tasks', 'invite_members', 'not_a_perm']));
    expect(perms.has('edit_tasks')).toBe(true);
    expect(perms.has('invite_members')).toBe(true);
    expect(perms.has('not_a_perm' as never)).toBe(false);
    expect(perms.size).toBe(2);
  });

  it('fails closed: empty string, corrupt JSON or non-arrays yield no perms', () => {
    expect(parsePerms('').size).toBe(0);
    expect(parsePerms('not json').size).toBe(0);
    expect(parsePerms('{"edit_tasks": true}').size).toBe(0); // object, not array
    expect(parsePerms('null').size).toBe(0);
  });

  it('the catalog is exactly the six documented flags', () => {
    expect([...GROUP_PERMS].sort()).toEqual([
      'edit_group', 'edit_tasks', 'invite_members',
      'manage_projects', 'moderate_messages', 'remove_members'
    ]);
  });
});

describe('group member patch schema (owner-only role/perms changes)', () => {
  it('accepts role changes and perm subsets, rejecting unknown perms and owner role', () => {
    expect(groupMemberPatchSchema.safeParse({ role: 'admin', perms: ['edit_tasks'] }).success).toBe(true);
    expect(groupMemberPatchSchema.safeParse({ perms: [] }).success).toBe(true);
    expect(groupMemberPatchSchema.safeParse({ role: 'owner' }).success).toBe(false);
    expect(groupMemberPatchSchema.safeParse({ perms: ['nope'] }).success).toBe(false);
  });
});

describe('chat message schemas', () => {
  it('caps the body at LIMITS.noteMax and rejects empty', () => {
    expect(messageCreateSchema.safeParse({ body: 'hi' }).success).toBe(true);
    expect(messageCreateSchema.safeParse({ body: '' }).success).toBe(false);
    expect(messageCreateSchema.safeParse({ body: ' '.repeat(10) }).success).toBe(false); // trimmed empty
    expect(messageCreateSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    expect(messageCreateSchema.safeParse({ body: 'x'.repeat(2000) }).success).toBe(true);
  });
});

describe('friend request + group schemas', () => {
  it('friend requests require the username shape (lowercased before the regex)', () => {
    expect(friendRequestSchema.safeParse({ username: 'dana' }).success).toBe(true);
    expect(friendRequestSchema.safeParse({ username: 'Dana' }).success).toBe(true); // zod lowercases in-chain
  });
  it('group names respect LIMITS.nameMax', () => {
    expect(groupCreateSchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
    expect(groupCreateSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
  });
  it('invite links take bounded expiry/uses (nullable = unlimited)', () => {
    expect(groupLinkCreateSchema.safeParse({}).success).toBe(true);
    expect(groupLinkCreateSchema.safeParse({ expires_in_days: null, max_uses: null }).success).toBe(true);
    expect(groupLinkCreateSchema.safeParse({ expires_in_days: 0 }).success).toBe(false);
    expect(groupLinkCreateSchema.safeParse({ expires_in_days: 366 }).success).toBe(false);
    expect(groupLinkCreateSchema.safeParse({ max_uses: 10_001 }).success).toBe(false);
  });
  it('read marks are clamped epoch-ms', () => {
    expect(readMarkSchema.safeParse({ at: Date.now() }).success).toBe(true);
    expect(readMarkSchema.safeParse({ at: -1 }).success).toBe(false);
  });
});
