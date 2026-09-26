// Join-by-link page (/join/:token): token-carrying invite links land here.
// Unauthenticated visitors are handled by App (login first, link re-opened);
// this component previews the group and performs the join.
import { useEffect, useState } from 'react';
import { store, pushToast, go, pathForView } from '../lib/store';
import { api } from '../lib/api';

interface Preview {
  group: { id: string; name: string; color: string; member_count: number };
}

export default function JoinGroupView({ token, onClose }: { token: string; onClose?: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const res = await api<Preview>(`/groups/join/preview?token=${encodeURIComponent(token)}`);
        if (!cancel) setPreview(res);
      } catch (e: any) {
        if (!cancel) setError(e.message);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [token]);

  async function join() {
    setBusy(true);
    try {
      const res = await api<{ group: Preview['group'] }>('/groups/join', { method: 'POST', body: { token } });
      pushToast('info', `Joined “${res.group.name}”`);
      void store.loadGroups();
      go(pathForView('social'));
    } catch (e: any) {
      pushToast('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="content"
      style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40 }}
    >
      <div className="card" style={{ maxWidth: 460, width: '100%' }}>
        <h3>{error ? 'Invite unavailable' : 'Join group'}</h3>
        {error ? (
          <>
            <p className="muted">{error}.</p>
            <button
              className="btn primary"
              onClick={() => {
                onClose?.();
                go(pathForView(store.get().view));
              }}
            >
              Go to app
            </button>
          </>
        ) : !preview ? (
          <p className="muted">Checking the invite…</p>
        ) : (
          <>
            <p>
              You've been invited to <b style={{ color: preview.group.color }}>{preview.group.name}</b>
              <span className="muted">
                {' '}
                · {preview.group.member_count} member{preview.group.member_count === 1 ? '' : 's'}
              </span>
            </p>
            <p className="muted">
              Joining shows you the group's chat and shared projects; members see your membership and group activity.
            </p>
            <button className="btn primary" disabled={busy} onClick={() => void join()}>
              {busy ? 'Joining…' : 'Join group'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
