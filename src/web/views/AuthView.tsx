// Login view — the only auth surface. Accounts are created by the admin (no
// self-signup); password resets go through the admin, or email when configured.
import { useEffect, useState } from 'react';
import { store, go } from '../lib/store';
import { api, ApiError } from '../lib/api';

export default function AuthView() {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');

  // Turnstile's data-callback references a global by name; assign it once at
  // module effect time
  useEffect(() => {
    (window as any).tkTurnstileCb = (token: string) => setTurnstileToken(token);
  }, []);

  useEffect(() => {
    // public (pre-auth) config — /settings requires a session
    api<{ turnstile_site_key: string | null }>('/config')
      .then((r) => setSiteKey(r.turnstile_site_key))
      .catch(() => setSiteKey(null));
  }, []);

  useEffect(() => {
    if (!siteKey) return;
    const id = 'ts-script';
    if (!document.getElementById(id)) {
      const s = document.createElement('script');
      s.id = id;
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      document.head.appendChild(s);
    }
  }, [siteKey]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>TimeKeep</h1>
        <p className="sub">Know where your hours go — private, fast, synced everywhere.</p>

        <LoginForm turnstileToken={turnstileToken}
          onDone={() => { store.setAuthed(true); go('/'); }} />

        {siteKey && (
          <div className="ts-wrap" style={{ marginTop: 12 }}>
            <div className="cf-turnstile" data-sitekey={siteKey} data-callback="tkTurnstileCb" />
          </div>
        )}
      </div>
    </div>
  );
}

interface LoginFormProps {
  turnstileToken: string;
  onDone: () => void;
}

function LoginForm({ turnstileToken, onDone }: LoginFormProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { identifier, password, turnstile: turnstileToken || undefined }
      });
      onDone();
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit}>
      <label className="field"><span>Username</span>
        <input className="input" type="text" required value={identifier} autoFocus
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
      <label className="field"><span>Password</span>
        <input className="input" type="password" required value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
