// Group chat panel (social phase 3): history via cursor pagination, live
// delivery through `group.message_*` sync events (relayed to this panel via the
// tk:group-message custom event), edit/delete per permission, unread badges.
import { useEffect, useRef, useState } from 'react';
import { store, pushToast } from '../lib/store';
import { api } from '../lib/api';
import { openPrompt } from '../components/PromptModal';

export interface ChatMessage {
  id: string;
  sender: { id: string; username: string; name: string };
  body: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export default function ChatPanel({ groupId, myUserId, canModerate }: {
  groupId: string; myUserId: string; canModerate: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await api<{ messages: ChatMessage[]; has_more: boolean }>(`/groups/${groupId}/messages`);
      setMessages(res.messages);
      setHasMore(res.has_more);
      await api(`/groups/${groupId}/read`, { method: 'POST' }); // open + caught up
      store.markGroupRead(groupId);
    } catch (e: any) { pushToast('error', e.message); setMessages([]); }
  }
  useEffect(() => { void load(); /* eslint-disable-line */ }, [groupId]);

  // live updates: created / updated / deleted relayed from store.applyEvent
  useEffect(() => {
    const onMsg = (e: Event) => {
      const d = (e as CustomEvent).detail as any;
      if (d?.group_id !== groupId) return;
      if (d.message) {
        const msg = d.message as ChatMessage;
        setMessages((prev) => {
          const list = prev ?? [];
          const i = list.findIndex((m) => m.id === msg.id);
          if (i === -1) return [...list, msg];
          const next = list.slice();
          next[i] = msg;
          return next;
        });
      } else if (d.message_id) {
        setMessages((prev) => (prev ?? []).map((m) => m.id === d.message_id
          ? { ...m, body: '', deleted_at: Date.now() } : m));
      }
      // any traffic while open = caught up: clear the badge + persist read state
      store.markGroupRead(groupId);
      void api(`/groups/${groupId}/read`, { method: 'POST' }).catch(() => {});
    };
    window.addEventListener('tk:group-message', onMsg);
    return () => window.removeEventListener('tk:group-message', onMsg);
  }, [groupId]);

  async function loadOlder() {
    if (!messages?.length) return;
    try {
      const res = await api<{ messages: ChatMessage[]; has_more: boolean }>(
        `/groups/${groupId}/messages?before=${messages[0]!.id}`);
      setMessages([...res.messages, ...messages]);
      setHasMore(res.has_more);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function send() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await api<{ message: ChatMessage }>(`/groups/${groupId}/messages`, {
        method: 'POST', body: { body }
      });
      setDraft('');
      setMessages((prev) => {
        const list = prev ?? [];
        return list.some((m) => m.id === res.message.id) ? list : [...list, res.message];
      });
    } catch (e: any) { pushToast('error', e.message); }
    finally { setBusy(false); }
  }

  async function editMsg(m: ChatMessage) {
    const v = await openPrompt({ title: 'Edit message', initialValue: m.body, confirmText: 'Save' });
    if (v === null || !v.trim() || v.trim() === m.body) return;
    try {
      const res = await api<{ message: ChatMessage }>(`/groups/${groupId}/messages/${m.id}`, {
        method: 'PATCH', body: { body: v.trim() }
      });
      setMessages((prev) => (prev ?? []).map((x) => x.id === res.message.id ? res.message : x));
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function deleteMsg(m: ChatMessage) {
    try {
      await api(`/groups/${groupId}/messages/${m.id}`, { method: 'DELETE' });
      setMessages((prev) => (prev ?? []).map((x) => x.id === m.id ? { ...x, body: '', deleted_at: Date.now() } : x));
    } catch (e: any) { pushToast('error', e.message); }
  }

  if (messages === null) return <div className="muted">Loading chat…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="tree-section-title">Chat</div>
      {hasMore && <button className="btn small" onClick={() => void loadOlder()}>Load older messages</button>}
      <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
        {messages.length === 0 && <div className="muted">No messages yet — say hi.</div>}
        {messages.map((m) => {
          const mine = m.sender.id === myUserId;
          const deleted = m.deleted_at !== null;
          return (
            <div key={m.id} className="row" style={{ paddingLeft: 8, minHeight: 26 }}>
              <span className="grow" style={{ fontSize: 13 }}>
                <b>{mine ? 'You' : (m.sender.name || '@' + m.sender.username)}</b>{' '}
                {deleted
                  ? <span className="muted done-text">message removed</span>
                  : <span style={m.updated_at > m.created_at ? { fontStyle: 'italic' } : undefined}>{m.body}</span>}
                <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                  {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {!deleted && m.updated_at > m.created_at ? ' (edited)' : ''}
                </span>
              </span>
              {!deleted && mine && (
                <button className="icon-btn" aria-label="Edit message" title="Edit"
                  onClick={() => void editMsg(m)}>✎</button>
              )}
              {!deleted && (mine || canModerate) && (
                <button className="icon-btn" aria-label="Delete message" title={mine ? 'Delete' : 'Delete (moderator)'}
                  onClick={() => void deleteMsg(m)}>✕</button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" style={{ minWidth: 0, flex: 1 }} value={draft} placeholder="Message the group…"
          aria-label="Chat message" maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn small primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
      </div>
    </div>
  );
}
