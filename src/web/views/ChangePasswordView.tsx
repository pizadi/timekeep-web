// Forced password change (admin-managed accounts): rendered exclusively until
// the password is updated — the server blocks every other API until then.
import { useState } from 'react';
import { store, useStore, pushToast } from '../lib/store';
import { api, ApiError } from '../lib/api';

export default function ChangePasswordView() {
  const user = useStore((s) => s.user)!;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError('The passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/me/password', { method: 'POST', body: { current_password: current, password: next } });
      store.setUser({ ...user, must_change_password: false });
      pushToast('info', `Password updated — welcome, ${user.name || user.username}`);
      void store.boot(); // load the real app state now that the gate is lifted
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Password change failed');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* session may already be gone */
    }
    location.href = '/login';
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>TimeKeep</h1>
        <p className="sub">
          You're signed in as <b>{user.username}</b> with a temporary password — set your own to continue.
        </p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Current password</span>
            <input
              className="input"
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="field">
            <span>New password (min 10 characters)</span>
            <input
              className="input"
              type="password"
              required
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              className="input"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Saving…' : 'Save and continue'}
          </button>
        </form>
        <div className="auth-links">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void signOut();
            }}
          >
            Sign out
          </a>
        </div>
      </div>
    </div>
  );
}
