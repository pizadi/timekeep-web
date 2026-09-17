// Password reset (FR-A5) — the target of the emailed `${origin}/reset?token=…` link.
import { useState } from 'react';
import { go } from '../lib/store';
import { api, ApiError } from '../lib/api';

export default function ResetPasswordView() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/auth/reset-confirm', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>TimeKeep</h1>
        {done ? (
          <>
            <p className="sub">Password updated — all previous sessions were signed out.</p>
            <button className="btn primary" style={{ width: '100%' }} onClick={() => go('/login')}>Sign in</button>
          </>
        ) : !token ? (
          <>
            <p className="sub">This reset link is incomplete.</p>
            <button className="btn" style={{ width: '100%' }} onClick={() => go('/login')}>Back to sign in</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="sub">Choose a new password.</p>
            <label className="field"><span>New password</span>
              <input className="input" type="password" required minLength={10} maxLength={200}
                value={password} autoFocus autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <div className="error-text" role="alert">{error}</div>}
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Saving…' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
