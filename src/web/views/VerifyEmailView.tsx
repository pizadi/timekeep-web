// Email verification (FR-A1) — the target of the emailed
// `${origin}/verify?token=…` link; posts the token to /auth/verify-email.
import { useEffect, useRef, useState } from 'react';
import { go } from '../lib/store';
import { api, ApiError } from '../lib/api';

export default function VerifyEmailView() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-mount safety
    ran.current = true;
    if (!token) {
      setState('error');
      setMessage('This verification link is incomplete.');
      return;
    }
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('ok'))
      .catch((err: unknown) => {
        setState('error');
        setMessage(err instanceof ApiError ? err.message : 'Verification failed');
      });
  }, [token]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>TimeKeep</h1>
        {state === 'working' && <p className="sub">Verifying your email…</p>}
        {state === 'ok' && (
          <>
            <p className="sub">Email verified — you're all set.</p>
            <button className="btn primary" style={{ width: '100%' }} onClick={() => go('/login')}>
              Sign in
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="error-text" role="alert">
              {message}
            </div>
            <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={() => go('/login')}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
