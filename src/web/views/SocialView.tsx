// Social view (phase 1): friends by username, pending requests, live presence,
// and read-only browsing of friends-visible projects (structure + aggregate
// time buckets — never raw session rows). Group chat/invites arrive in phase 2+.
import { useEffect, useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import type { FriendSummary, FriendPresence } from '../lib/store';
import { api } from '../lib/api';
import { openPrompt } from '../components/PromptModal';

export default function SocialView() {
  const friends = useStore((s) => s.friends);
  const incoming = useStore((s) => s.incoming);
  const outgoing = useStore((s) => s.outgoing);
  const presence = useStore((s) => s.friendPresence);
  const [addName, setAddName] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // fresh lists on entry (bootstrap already seeded them)
  useEffect(() => { void store.loadSocial(); }, []);

  // one-shot presence fetch for the current friend set; live updates arrive
  // continuously via friend.timer events (store.applyEvent)
  useEffect(() => {
    if (friends.length === 0) return;
    let cancel = false;
    void (async () => {
      try {
        const res = await api<{ presence: Record<string, FriendPresence | null> }>('/friends/presence', {
          method: 'POST',
          body: { ids: friends.map((f) => f.id) }
        });
        if (!cancel) store.setFriendPresence(res.presence ?? {});
      } catch { /* presence is best-effort */ }
    })();
    return () => { cancel = true; };
  }, [friends]);

  async function addFriend() {
    const username = addName.trim().toLowerCase();
    if (!username || busy) return;
    setBusy(true);
    try {
      const res = await api<{ accepted?: boolean; friend?: FriendSummary }>('/friends/requests', {
        method: 'POST', body: { username }
      });
      if (res.accepted && res.friend) pushToast('info', `You are now friends with ${res.friend.name || '@' + res.friend.username}`);
      else pushToast('info', `Friend request sent to @${username}`);
      setAddName('');
      void store.loadSocial();
    } catch (e: any) {
      pushToast('error', e.message);
    } finally { setBusy(false); }
  }

  async function respond(requestId: string, action: 'accept' | 'decline') {
    try {
      await api(`/friends/requests/${requestId}/${action}`, { method: 'POST' });
      if (action === 'accept') pushToast('info', 'Friend added');
      void store.loadSocial();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function cancelRequest(requestId: string) {
    try {
      await api(`/friends/requests/${requestId}`, { method: 'DELETE' });
      void store.loadSocial();
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function unfriend(f: FriendSummary) {
    const typed = await openPrompt({
      title: `Remove ${f.name || '@' + f.username}?`,
      message: 'They will no longer see your friends-visible projects, and you lose access to theirs.',
      placeholder: f.username,
      confirmText: 'Remove',
      danger: true,
      mustType: f.username
    });
    if (typed === null || typed.trim() !== f.username) return;
    try {
      await api(`/friends/${f.id}`, { method: 'DELETE' });
      if (expanded === f.id) setExpanded(null);
      void store.loadSocial();
    } catch (e: any) { pushToast('error', e.message); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
      <div className="card">
        <h3>Add a friend</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Send a request by username. Friends can see the projects you mark <b>visible to friends</b> —
          structure, total tracked time and whether you're tracking right now. Nothing else is shared.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input" style={{ minWidth: 0, flex: 1 }} value={addName} placeholder="username"
            aria-label="Friend username" disabled={busy}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addFriend(); }}
          />
          <button className="btn primary" disabled={busy || !addName.trim()} onClick={() => void addFriend()}>
            Send request
          </button>
        </div>
      </div>

      {(incoming.length > 0 || outgoing.length > 0) && (
        <div className="card">
          <h3>Requests</h3>
          {incoming.map((r) => (
            <div key={r.request_id} className="row">
              <span className="grow"><b>{r.name || r.username}</b> <span className="muted">@{r.username}</span></span>
              <button className="btn small primary" onClick={() => void respond(r.request_id, 'accept')}>Accept</button>
              <button className="btn small" onClick={() => void respond(r.request_id, 'decline')}>Decline</button>
            </div>
          ))}
          {outgoing.map((r) => (
            <div key={r.request_id} className="row">
              <span className="grow done-text">
                To <b>{r.name || r.username}</b> <span className="muted">@{r.username}</span> — <span className="muted">pending</span>
              </span>
              <button className="btn small" onClick={() => void cancelRequest(r.request_id)}>Cancel</button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Friends {friends.length > 0 && <span className="muted">({friends.length})</span>}</h3>
        {friends.length === 0 && <p className="muted">No friends yet — send a request above.</p>}
        {friends.map((f) => {
          const live = presence[f.id] ?? null;
          return (
            <div key={f.id}>
              <div className="row" role="button" tabIndex={0} aria-expanded={expanded === f.id}
                style={{ cursor: 'pointer' }}
                onClick={() => setExpanded(expanded === f.id ? null : f.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') setExpanded(expanded === f.id ? null : f.id); }}>
                {live && <span className="dot-running" aria-label="tracking now" />}
                <span className="grow">
                  <b>{f.name || f.username}</b> <span className="muted">@{f.username}</span>
                  {live && <span className="muted"> — tracking “{live.task_name}”</span>}
                </span>
                <button className="icon-btn" aria-label={`Remove friend ${f.username}`} title="Remove friend"
                  onClick={(e) => { e.stopPropagation(); void unfriend(f); }}>🗑</button>
              </div>
              {expanded === f.id && <FriendProjects friendId={f.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Read-only list of a friend's friends-visible projects + their live dot. */
function FriendProjects({ friendId }: { friendId: string }) {
  const [projects, setProjects] = useState<any[] | null>(null);
  const [running, setRunning] = useState<FriendPresence | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const res = await api<{ projects: any[]; running: FriendPresence | null }>(`/friends/${friendId}/projects`);
        if (!cancel) { setProjects(res.projects ?? []); setRunning(res.running ?? null); }
      } catch {
        if (!cancel) setProjects([]);
      }
    })();
    return () => { cancel = true; };
  }, [friendId]);

  if (projects === null) return <div className="muted" style={{ padding: '4px 12px 10px' }}>Loading…</div>;
  if (projects.length === 0) return <div className="muted" style={{ padding: '4px 12px 10px' }}>No shared projects.</div>;

  return (
    <div style={{ padding: '2px 12px 10px' }}>
      {projects.map((p) => (
        <div key={p.id}>
          <div className="row" role="button" tabIndex={0} aria-expanded={open === p.id}
            style={{ cursor: 'pointer', paddingLeft: 20 }}
            onClick={() => setOpen(open === p.id ? null : p.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') setOpen(open === p.id ? null : p.id); }}>
            <span className="chip" style={{ background: p.color }} aria-hidden />
            <span className="grow">{p.name}{p.archived ? ' (archived)' : ''}</span>
            {running?.project_id === p.id && <span className="dot-running" aria-label="tracking now" />}
          </div>
          {open === p.id && <FriendProjectDetail friendId={friendId} projectId={p.id} />}
        </div>
      ))}
    </div>
  );
}

/** Structure + aggregate buckets for one shared project (read-only). */
function FriendProjectDetail({ friendId, projectId }: { friendId: string; projectId: string }) {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const res = await api<any>(`/friends/${friendId}/projects/${projectId}`);
        if (!cancel) setData(res);
      } catch (e: any) {
        if (!cancel) setError(e.message);
      }
    })();
    return () => { cancel = true; };
  }, [friendId, projectId]);

  if (error) return <div className="muted" style={{ padding: '4px 12px 10px 38px' }}>Could not load: {error}</div>;
  if (!data) return <div className="muted" style={{ padding: '4px 12px 10px 38px' }}>Loading…</div>;

  const maxMs = Math.max(1, ...data.days.map((d: any) => d.minutes));
  const subtaskCount = (taskId: string) => data.subtasks.filter((s: any) => s.task_id === taskId).length;

  return (
    <div style={{ padding: '2px 12px 12px 38px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Last 30 days: <b>{data.total_minutes}</b> min tracked{data.running ? ' · tracking now' : ''}
      </div>
      {data.days.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }} aria-hidden>
          {data.days.map((d: any) => (
            <div key={d.day} title={`${d.day}: ${d.minutes} min`}
              style={{ width: 10, height: `${Math.max(6, (d.minutes / maxMs) * 100)}%`, background: data.project.color, borderRadius: 2, opacity: 0.75 }} />
          ))}
        </div>
      )}
      <table className="tbl"><tbody>
        {data.tasks.map((t: any) => (
          <tr key={t.id}>
            <td style={{ width: 24 }}><input type="checkbox" checked={!!t.done} readOnly aria-label={`Done: ${t.name}`} /></td>
            <td className={t.done ? 'done-text' : ''}>{t.name}</td>
            <td className="muted" style={{ textAlign: 'right' }}>
              {subtaskCount(t.id) > 0 ? `${subtaskCount(t.id)} subtask${subtaskCount(t.id) > 1 ? 's' : ''}` : ''}
            </td>
          </tr>
        ))}
        {data.tasks.length === 0 && <tr><td className="muted">No tasks yet.</td></tr>}
      </tbody></table>
    </div>
  );
}
