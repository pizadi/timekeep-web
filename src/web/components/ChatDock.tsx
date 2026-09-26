// Chat dock (social phase 3 UI v2): each group gets its own chat window docked
// to the bottom-right of the shell — collapsible to a header bar, scrollable,
// with lazy loading of older history when scrolled to the top (server
// `before=` cursor pagination). Live delivery rides the `group.message_*`
// sync events relayed to open windows via the tk:group-message CustomEvent;
// the sender's acting device applies its own POST/PATCH response (its WS echo
// is ignored by the actor===deviceId guard in store.applyEvent).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import type { GroupSummary } from '../lib/store';
import { api } from '../lib/api';
import { openPrompt } from './PromptModal';
import { parseGroupPerms } from '../../shared/constants';

export interface ChatMessage {
  id: string;
  sender: { id: string; username: string; name: string };
  body: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------- dock state (module-level so windows survive view switches) ----------
type DockState = { open: string[]; collapsed: string[]; launcherOpen: boolean };
const LS_KEY = 'tk.chatDock';
const MAX_EXPANDED = 3; // beyond this, the oldest expanded windows auto-collapse

function loadDock(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { open: ids(raw.open), collapsed: ids(raw.collapsed), launcherOpen: false };
  } catch { return { open: [], collapsed: [], launcherOpen: false }; }
}

let dock: DockState = loadDock();
const dockListeners = new Set<() => void>();
function setDock(patch: Partial<DockState>): void {
  dock = { ...dock, ...patch };
  try { localStorage.setItem(LS_KEY, JSON.stringify({ open: dock.open, collapsed: dock.collapsed })); } catch { /* storage may be blocked */ }
  for (const l of dockListeners) l();
}
function subscribeDock(l: () => void): () => void {
  dockListeners.add(l);
  return () => { dockListeners.delete(l); };
}

export const chatDock = {
  open(groupId: string): void {
    if (dock.open.includes(groupId)) {
      setDock({ collapsed: dock.collapsed.filter((id) => id !== groupId) });
      return;
    }
    const open = [...dock.open, groupId];
    const collapsed = new Set(dock.collapsed);
    let expanded = open.filter((id) => !collapsed.has(id)).length;
    for (const id of open) { // collapse oldest expanded windows beyond the cap
      if (expanded <= MAX_EXPANDED) break;
      if (!collapsed.has(id) && id !== groupId) { collapsed.add(id); expanded--; }
    }
    setDock({ open, collapsed: [...collapsed] });
  },
  close(groupId: string): void {
    setDock({
      open: dock.open.filter((id) => id !== groupId),
      collapsed: dock.collapsed.filter((id) => id !== groupId)
    });
  },
  toggleCollapsed(groupId: string): void {
    setDock({
      collapsed: dock.collapsed.includes(groupId)
        ? dock.collapsed.filter((id) => id !== groupId)
        : [...dock.collapsed, groupId]
    });
  },
  toggleLauncher(): void { setDock({ launcherOpen: !dock.launcherOpen }); }
};

export function useChatDock(): DockState {
  return useSyncExternalStore(subscribeDock, () => dock);
}

// ---------- dock shell ----------

export default function ChatDock() {
  const groups = useStore((s) => s.groups);
  const me = useStore((s) => s.user);
  const ds = useChatDock();
  const popRef = useRef<HTMLDivElement>(null);

  // close the launcher popover on outside pointerdown
  useEffect(() => {
    if (!ds.launcherOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setDock({ launcherOpen: false });
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [ds.launcherOpen]);

  // only windows for groups the user is still a member of
  const openGroups = ds.open
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is GroupSummary => !!g);
  const unreadElsewhere = groups.reduce((a, g) => a + (!ds.open.includes(g.id) && g.unread > 0 ? g.unread : 0), 0);

  return (
    <div className="chat-dock">
      {openGroups.map((g) => {
        const collapsed = ds.collapsed.includes(g.id);
        const canModerate = g.role === 'owner' || parseGroupPerms(g.perms).includes('moderate_messages');
        return (
          <section key={g.id} className={`chat-win${collapsed ? ' collapsed' : ''}`} aria-label={`Chat: ${g.name}`}>
            <div
              className="chat-win-head" role="button" tabIndex={0} aria-expanded={!collapsed}
              onClick={() => chatDock.toggleCollapsed(g.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') chatDock.toggleCollapsed(g.id); }}
            >
              <span className="chip" style={{ background: g.color }} aria-hidden />
              <span className="grow" title={g.name}>{g.name}</span>
              {collapsed && g.unread > 0 && <span className="chat-badge">{g.unread > 99 ? '99+' : g.unread}</span>}
              <button className="icon-btn" aria-label={collapsed ? 'Expand chat' : 'Collapse chat'}
                onClick={(e) => { e.stopPropagation(); chatDock.toggleCollapsed(g.id); }}>
                {collapsed ? '▴' : '▾'}
              </button>
              <button className="icon-btn" aria-label={`Close ${g.name} chat`}
                onClick={(e) => { e.stopPropagation(); chatDock.close(g.id); }}>✕</button>
            </div>
            {!collapsed && me && (
              <ChatBody groupId={g.id} myUserId={me.id} canModerate={canModerate} />
            )}
          </section>
        );
      })}

      <div className="chat-launcher-wrap" ref={popRef}>
        {ds.launcherOpen && (
          <div className="chat-pop" role="menu" aria-label="Group chats">
            {groups.length === 0 && <div className="muted" style={{ padding: '10px 12px' }}>No groups yet.</div>}
            {groups.map((g) => {
              const isOpen = ds.open.includes(g.id);
              return (
                <button key={g.id} role="menuitem" className="chat-pop-item"
                  onClick={() => (isOpen ? chatDock.close(g.id) : chatDock.open(g.id))}>
                  <span className="chip" style={{ background: g.color }} aria-hidden />
                  <span className="grow">{g.name}</span>
                  {isOpen ? <span className="muted" style={{ fontSize: 12 }}>open</span>
                    : g.unread > 0 ? <span className="chat-badge">{g.unread > 99 ? '99+' : g.unread}</span> : null}
                </button>
              );
            })}
          </div>
        )}
        <button className="chat-launcher" aria-label={`Group chats${unreadElsewhere ? ` — ${unreadElsewhere} unread` : ''}`}
          aria-expanded={ds.launcherOpen} onClick={() => chatDock.toggleLauncher()}>
          💬
          {unreadElsewhere > 0 && <span className="chat-badge chat-launcher-badge">{unreadElsewhere > 99 ? '99+' : unreadElsewhere}</span>}
        </button>
      </div>
    </div>
  );
}

// ---------- one window's message list + composer ----------

function ChatBody({ groupId, myUserId, canModerate }: {
  groupId: string; myUserId: string; canModerate: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = () => {
    const el = listRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  async function load() {
    try {
      const res = await api<{ messages: ChatMessage[]; has_more: boolean }>(`/groups/${groupId}/messages`);
      setMessages(res.messages);
      setHasMore(res.has_more);
      await api(`/groups/${groupId}/read`, { method: 'POST' }); // open + caught up
      store.markGroupRead(groupId);
      requestAnimationFrame(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; });
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
        if (nearBottom()) requestAnimationFrame(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; });
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

  /** Lazy history: prepend the next older page and keep the viewport anchored
   *  to the same messages (scrollHeight delta applied to scrollTop). */
  async function loadOlder() {
    const el = listRef.current;
    if (!messages?.length || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const res = await api<{ messages: ChatMessage[]; has_more: boolean }>(
        `/groups/${groupId}/messages?before=${messages[0]!.id}`);
      setMessages((prev) => [...res.messages, ...(prev ?? [])]);
      setHasMore(res.has_more);
      requestAnimationFrame(() => {
        const el2 = listRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop;
      });
    } catch (e: any) { pushToast('error', e.message); }
    finally { setLoadingOlder(false); }
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
      requestAnimationFrame(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; });
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

  if (messages === null) return <div className="muted chat-loading">Loading chat…</div>;

  return (
    <>
      <div className="chat-msgs" ref={listRef}
        onScroll={() => { const el = listRef.current; if (el && el.scrollTop < 40) void loadOlder(); }}>
        {hasMore && (
          <div style={{ textAlign: 'center', padding: '2px 0 6px' }}>
            <button className="btn small" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 && <div className="muted" style={{ padding: 8 }}>No messages yet — say hi.</div>}
        {messages.map((m) => {
          const mine = m.sender.id === myUserId;
          const deleted = m.deleted_at !== null;
          return (
            <div key={m.id} className="chat-msg">
              <span className="grow">
                <b>{mine ? 'You' : (m.sender.name || '@' + m.sender.username)}</b>{' '}
                {deleted
                  ? <span className="muted done-text">message removed</span>
                  : <span className="msg-body" style={m.updated_at > m.created_at ? { fontStyle: 'italic' } : undefined}>{m.body}</span>}
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
      <div className="chat-compose">
        <input className="input" value={draft} placeholder="Message the group…"
          aria-label="Chat message" maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn small primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
      </div>
    </>
  );
}
