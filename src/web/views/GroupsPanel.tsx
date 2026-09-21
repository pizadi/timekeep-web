// Groups panel (social phase 2): create/join groups, member management with the
// owner's fine-grained permission editor, username invites, token invite links.
// Live updates arrive as `group.*` signals (store refetches); mutations apply
// via refetch of the (small) group payloads.
import { useEffect, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import type { GroupSummary, GroupInviteRow } from '../lib/store';
import { api, ApiError } from '../lib/api';
import { openPrompt } from '../components/PromptModal';
import { GROUP_PERMS, type GroupPerm } from '../../shared/constants';
import ChatPanel from './ChatPanel';
import Dropdown from '../components/Dropdown';

const PERM_LABELS: Record<GroupPerm, string> = {
  invite_members: 'Invite members (requests + links)',
  remove_members: 'Remove members',
  edit_group: 'Rename / restyle group',
  manage_projects: 'Manage group projects',
  moderate_messages: 'Moderate chat messages',
  edit_tasks: 'Create & edit tasks'
};

export function parseGroupPerms(raw: string): GroupPerm[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => GROUP_PERMS.includes(p)) : [];
  } catch { return []; }
}

export default function GroupsPanel() {
  const groups = useStore((s) => s.groups);
  const invites = useStore((s) => s.groupInvites);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { void store.loadGroups(); }, []);

  async function createGroup() {
    const name = await openPrompt({ title: 'New group', placeholder: 'Group name', confirmText: 'Create' });
    if (!name?.trim()) return;
    try {
      await api('/groups', { method: 'POST', body: { name: name.trim() } });
      void store.loadGroups();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function respond(inviteId: string, action: 'accept' | 'decline') {
    try {
      await api(`/groups/invites/${inviteId}/${action}`, { method: 'POST' });
      pushToast('info', action === 'accept' ? 'Joined group' : 'Invite declined');
      void store.loadGroups();
    } catch (e: any) { pushToast('error', e.message); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
      <div className="card">
        <h3>Groups {groups.length > 0 && <span className="muted">({groups.length})</span>}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          A group shares a member list, a chat and (soon) group projects. Invite by username or a
          shareable link; the owner grants admins exactly the permissions you pick.
        </p>
        <button className="btn small primary" onClick={() => void createGroup()}>＋ Group</button>
        <div style={{ marginTop: 8 }}>
          {groups.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No groups yet — create one or accept an invite.</p>}
          {groups.map((g) => {
            const live = g.role === 'owner' ? 'owner' : g.role;
            return (
              <div key={g.id}>
                <div className="row" role="button" tabIndex={0} aria-expanded={expanded === g.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setExpanded(expanded === g.id ? null : g.id); }}>
                  <span className="chip" style={{ background: g.color }} aria-hidden />
                  <span className="grow">
                    <b>{g.name}</b> <span className="muted">· {g.member_count} member{g.member_count === 1 ? '' : 's'} · {live}</span>
                    {g.unread > 0 && <span className="muted"> · <b style={{ color: 'var(--accent, #4f8cff)' }}>{g.unread} new</b></span>}
                  </span>
                </div>
                {expanded === g.id && <GroupDetail group={g} />}
              </div>
            );
          })}
        </div>
      </div>

      {invites.length > 0 && (
        <div className="card">
          <h3>Group invites</h3>
          {invites.map((inv) => (
            <div key={inv.invite_id} className="row">
              <span className="grow">
                <b>{inv.name}</b> <span className="muted">· invited by {inv.inviter_name || '@' + inv.inviter_username}</span>
              </span>
              <button className="btn small primary" onClick={() => void respond(inv.invite_id, 'accept')}>Accept</button>
              <button className="btn small" onClick={() => void respond(inv.invite_id, 'decline')}>Decline</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface MemberRow { id: string; username: string; name: string; role: 'owner' | 'admin' | 'member'; perms: string; joined_at: number }

function GroupDetail({ group }: { group: GroupSummary }) {
  const me = useStore((s) => s.user);
  const projects = useStore((s) => s.projects);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [myPerms, setMyPerms] = useState<GroupPerm[]>([]);
  const [myRole, setMyRole] = useState<string>('member');
  const [editing, setEditing] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const reload = async () => {
    try {
      const res = await api<any>(`/groups/${group.id}`);
      setMembers(res.members ?? []);
      setMyPerms(res.my_perms ?? []);
      setMyRole(res.my_role ?? 'member');
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) { setMembers([]); return; }
      pushToast('error', e.message);
    }
  };
  useEffect(() => { void reload(); /* eslint-disable-line */ }, [group.id]);

  const isOwner = myRole === 'owner';
  const can = (p: GroupPerm) => isOwner || myPerms.includes(p);

  async function leave() {
    const typed = await openPrompt({
      title: `Leave “${group.name}”?`,
      message: 'You lose access to the group and its shared work. Re-joining needs a new invite.',
      placeholder: group.name, confirmText: 'Leave', danger: true, mustType: group.name
    });
    if (typed === null || typed.trim() !== group.name) return;
    try {
      await api(`/groups/${group.id}/leave`, { method: 'POST' });
      void store.loadGroups();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function deleteGroup() {
    const typed = await openPrompt({
      title: `Delete “${group.name}”?`,
      message: 'This removes the group, its members, invites and links. Group projects and their tracked time are removed with it (undo is not available).',
      placeholder: group.name, confirmText: 'Delete', danger: true, mustType: group.name
    });
    if (typed === null || typed.trim() !== group.name) return;
    try {
      await api(`/groups/${group.id}`, { method: 'DELETE' });
      void store.loadGroups();
    } catch (e: any) { pushToast('error', e.message); }
  }

  if (members === null) return <div className="muted" style={{ padding: '4px 12px 10px' }}>Loading…</div>;

  return (
    <div style={{ padding: '2px 12px 10px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => setChatOpen((v) => !v)} aria-expanded={chatOpen}>
          💬 Chat {chatOpen ? '▾' : '▸'}
        </button>
        {isOwner && <button className="btn small" onClick={() => void deleteGroup()}>🗑 Delete group</button>}
        {!isOwner && <button className="btn small" onClick={() => void leave()}>Leave group</button>}
      </div>

      {chatOpen && me && <ChatPanel groupId={group.id} myUserId={me.id} canModerate={myPerms.includes('moderate_messages')} />}

      <div>
        <div className="tree-section-title">Group projects (feature 6 — members only)</div>
        {projects.filter((p) => p.group_id === group.id).map((p) => (
          <div key={p.id} className="row" style={{ paddingLeft: 12 }}>
            <span className="chip" style={{ background: p.color }} aria-hidden />
            <span className="grow">{p.name}{p.archived ? ' (archived)' : ''}</span>
            {can('manage_projects') && !p.archived && (
              <button className="icon-btn" aria-label={`Archive ${p.name}`} title="Archive"
                onClick={async () => {
                  try {
                    const res = await api<{ project: any }>(`/projects/${p.id}`, { method: 'PATCH', body: { archived: true } });
                    store.upsertLocal('project', res.project);
                  } catch (e: any) { pushToast('error', e.message); }
                }}>📦</button>
            )}
            {can('manage_projects') && (
              <button className="icon-btn" aria-label={`Delete ${p.name}`} title="Delete for all members (no undo)"
                onClick={async () => {
                  const typed = await openPrompt({
                    title: `Delete “${p.name}” for everyone?`,
                    message: 'Tasks, checklists and all members’ tracked time on this project are removed. This cannot be undone.',
                    placeholder: p.name, confirmText: 'Delete', danger: true, mustType: p.name
                  });
                  if (typed === null || typed.trim() !== p.name) { pushToast('info', 'Deletion cancelled'); return; }
                  try {
                    await api(`/projects/${p.id}`, { method: 'DELETE' });
                    store.removeLocalProject(p.id);
                  } catch (e: any) { pushToast('error', e.message); }
                }}>🗑</button>
            )}
          </div>
        ))}
        {can('manage_projects') && (
          <div style={{ padding: '4px 0 0 12px' }}>
            <button className="btn small" onClick={async () => {
              const name = await openPrompt({ title: 'New group project', placeholder: 'Project name', confirmText: 'Create' });
              if (!name?.trim()) return;
              try {
                const res = await api<{ project: any }>(`/groups/${group.id}/projects`, { method: 'POST', body: { name: name.trim() } });
                store.upsertLocal('project', res.project);
                store.selectProject(res.project.id);
              } catch (e: any) { pushToast('error', e.message); }
            }}>＋ Project</button>
          </div>
        )}
      </div>

      <div>
        <div className="tree-section-title">Members ({members.length})</div>
        {members.map((m) => {
          const self = m.role === 'owner';
          return (
            <div key={m.id}>
              <div className="row" role="button" tabIndex={0} aria-expanded={editing === m.id}
                style={{ cursor: isOwner && !self ? 'pointer' : 'default', paddingLeft: 12 }}
                onClick={() => { if (isOwner && !self) setEditing(editing === m.id ? null : m.id); }}>
                <span className="grow">{m.name || m.username} <span className="muted">@{m.username}</span></span>
                <span className="muted" style={{ fontSize: 12 }}>{m.role}</span>
                {can('remove_members') && !self && m.role !== 'owner' && (
                  <button className="icon-btn" aria-label={`Remove ${m.username}`} title="Remove from group"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try { await api(`/groups/${group.id}/members/${m.id}`, { method: 'DELETE' }); void reload(); }
                      catch (e2: any) { pushToast('error', e2.message); }
                    }}>✕</button>
                )}
              </div>
              {isOwner && !self && editing === m.id && (
                <MemberPermEditor groupId={group.id} member={m} onSaved={() => { setEditing(null); void reload(); }} />
              )}
            </div>
          );
        })}
      </div>

      {can('invite_members') && <GroupInvites groupId={group.id} />}
      {can('invite_members') && <GroupLinks groupId={group.id} />}
    </div>
  );
}

/** Owner-only per-member permission editor (feature 5). */
function MemberPermEditor({ groupId, member, onSaved }: {
  groupId: string; member: MemberRow; onSaved: () => void;
}) {
  const [role, setRole] = useState<'admin' | 'member'>(member.role === 'admin' ? 'admin' : 'member');
  const [perms, setPerms] = useState<Set<GroupPerm>>(new Set(parseGroupPerms(member.perms)));
  const [busy, setBusy] = useState(false);

  function toggle(p: GroupPerm) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/groups/${groupId}/members/${member.id}`, {
        method: 'PATCH', body: { role, perms: [...perms] }
      });
      onSaved();
    } catch (e: any) { pushToast('error', e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: '4px 12px 10px 28px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Role:
        <Dropdown style={{ width: 140 }} ariaLabel="Member role" value={role} onChange={(v) => setRole(v as 'admin' | 'member')}
          options={[
            { value: 'member', label: 'Member', icon: '👤' },
            { value: 'admin', label: 'Admin', icon: '🛡' }
          ]} />
      </label>
      {GROUP_PERMS.map((p) => (
        <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={perms.has(p)} onChange={() => toggle(p)} />
          <span>{PERM_LABELS[p]} <span className="muted">({p})</span></span>
        </label>
      ))}
      <div><button className="btn small primary" disabled={busy} onClick={() => void save()}>Save member</button></div>
    </div>
  );
}

function GroupInvites({ groupId }: { groupId: string }) {
  const [invites, setInvites] = useState<any[] | null>(null);
  const [name, setName] = useState('');

  const reload = async () => {
    try {
      const res = await api<{ invites: any[] }>(`/groups/${groupId}/invites`);
      setInvites(res.invites ?? []);
    } catch { setInvites([]); }
  };
  useEffect(() => { void reload(); /* eslint-disable-line */ }, [groupId]);

  async function invite() {
    const username = name.trim().toLowerCase();
    if (!username) return;
    try {
      await api(`/groups/${groupId}/invites`, { method: 'POST', body: { username } });
      pushToast('info', `Invite sent to @${username}`);
      setName('');
      void reload();
    } catch (e: any) { pushToast('error', e.message); }
  }

  return (
    <div>
      <div className="tree-section-title">Invites</div>
      <div style={{ display: 'flex', gap: 8, padding: '0 0 6px' }}>
        <input className="input" style={{ minWidth: 0, flex: 1 }} value={name} placeholder="username"
          aria-label="Invite by username" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }} />
        <button className="btn small" disabled={!name.trim()} onClick={() => void invite()}>Invite</button>
      </div>
      {(invites ?? []).map((inv) => (
        <div key={inv.invite_id} className="row" style={{ paddingLeft: 12 }}>
          <span className="grow">{inv.name || inv.username} <span className="muted">@{inv.username}</span> <span className="muted">— pending</span></span>
          <button className="icon-btn" aria-label={`Cancel invite for ${inv.username}`} title="Cancel invite"
            onClick={async () => {
              try { await api(`/groups/invites/${inv.invite_id}`, { method: 'DELETE' }); void reload(); }
              catch (e: any) { pushToast('error', e.message); }
            }}>✕</button>
        </div>
      ))}
    </div>
  );
}

function GroupLinks({ groupId }: { groupId: string }) {
  const [links, setLinks] = useState<any[] | null>(null);
  const [freshToken, setFreshToken] = useState<{ path: string } | null>(null);

  const reload = async () => {
    try {
      const res = await api<{ links: any[] }>(`/groups/${groupId}/links`);
      setLinks(res.links ?? []);
    } catch { setLinks([]); }
  };
  useEffect(() => { void reload(); /* eslint-disable-line */ }, [groupId]);

  async function createLink() {
    try {
      const res = await api<{ join_path: string }>('/groups/' + groupId + '/links', {
        method: 'POST', body: { expires_in_days: 7 }
      });
      setFreshToken({ path: res.join_path });
      void reload();
    } catch (e: any) { pushToast('error', e.message); }
  }

  const fullUrl = freshToken ? `${location.origin}${freshToken.path}` : null;

  return (
    <div>
      <div className="tree-section-title">Invite links</div>
      <div style={{ padding: '0 0 6px' }}>
        <button className="btn small" onClick={() => void createLink()}>🔗 New link (7-day)</button>
      </div>
      {fullUrl && (
        <div className="row" style={{ paddingLeft: 12, gap: 6 }}>
          <code className="grow" style={{ fontSize: 12, wordBreak: 'break-all' }}>{fullUrl}</code>
          <button className="btn small primary" onClick={async () => {
            try { await navigator.clipboard.writeText(fullUrl); pushToast('info', 'Link copied — it is shown only once'); }
            catch { pushToast('error', 'copy failed — select the link text manually'); }
          }}>Copy</button>
          <button className="icon-btn" aria-label="Dismiss link" title="Dismiss (the link stays valid until revoked)"
            onClick={() => setFreshToken(null)}>✕</button>
        </div>
      )}
      {(links ?? []).filter((l) => !l.revoked_at).map((l) => (
        <div key={l.id} className="row" style={{ paddingLeft: 12 }}>
          <span className="grow muted" style={{ fontSize: 12.5 }}>
            {l.use_count} use{l.use_count === 1 ? '' : 's'}
            {l.max_uses ? ` / ${l.max_uses}` : ''} · {l.expires_at ? `expires ${new Date(l.expires_at).toLocaleDateString()}` : 'no expiry'}
          </span>
          <button className="icon-btn" aria-label="Revoke link" title="Revoke"
            onClick={async () => {
              try { await api(`/groups/${groupId}/links/${l.id}`, { method: 'DELETE' }); void reload(); }
              catch (e: any) { pushToast('error', e.message); }
            }}>✕</button>
        </div>
      ))}
    </div>
  );
}
