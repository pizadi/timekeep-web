// Settings (FR-C1/C2/C3): pomodoro, theme, timezone/week-start, grace period,
// notifications, security (active sessions FR-A6), danger zone (export FR-D1,
// delete account FR-A8).
import { useEffect, useState } from 'react';
import { store, useStore, pushToast, go } from '../lib/store';
import { api } from '../lib/api';
import { applyTheme, ThemePref } from '../lib/theme';
import { MIN_PASSWORD, POMODORO_LIMITS } from '../../shared/constants';
import { useModalA11y } from '../lib/modal';
import Combobox from '../components/Combobox';

interface AuthSessionRow { id: string; user_agent: string; ip: string; created_at: number; last_seen_at: number; current: boolean }
interface AdminUserRow {
  id: string; username: string; email: string; name: string;
  role: 'user' | 'admin'; active: 0 | 1; must_change_password: boolean;
  email_verified_at: number | null; created_at: number;
}

// Theme is applied through the imported applyTheme().
export default function SettingsView({ onClose, currentTheme }: {
  onClose: () => void;
  currentTheme: ThemePref;
}) {
  const user = useStore((s) => s.user)!;
  const settings = useStore((s) => s.settings);
  const [sessions, setSessions] = useState<AuthSessionRow[]>([]);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [notifState, setNotifState] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [tzText, setTzText] = useState(user.timezone);

  useEffect(() => { void api<{ sessions: AuthSessionRow[] }>('/me/sessions').then((r) => setSessions(r.sessions)).catch(() => {}); }, []);

  if (!settings) return null;

  async function save(patch: unknown) {
    try {
      const res = await api<{ settings: any }>('/settings', { method: 'PUT', body: patch });
      store.setSettings(res.settings);
      pushToast('info', 'Settings saved — applied on every device');
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function saveProfile(patch: unknown) {
    try {
      const res = await api<{ user: any }>('/me', { method: 'PATCH', body: patch });
      store.setUser(res.user);
      pushToast('info', 'Profile saved');
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function enableNotifications(on: boolean) {
    if (!on) { await save({ notifications_enabled: false }); return; }
    if (typeof Notification === 'undefined') { pushToast('error', 'Notifications are not supported in this browser'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setNotifState(perm);
    if (perm === 'granted') await save({ notifications_enabled: true });
    else pushToast('error', 'Notification permission was not granted');
  }

  /**
   * Pomodoro mode: the plain timer becomes a pomodoro (focus blocks + break
   * prompts). Turning it ON asks for notification permission right away (user
   * gesture, FR-Nt1) so end-of-run notifications can fire; run endings always
   * show as in-app toasts even if the browser permission is denied.
   */
  async function enablePomodoro(on: boolean) {
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* unsupported quirks */ }
      setNotifState(Notification.permission);
    }
    const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    try {
      const res = await api<{ settings: any }>('/settings', {
        method: 'PUT',
        body: { pomodoro: { enabled: on }, ...(on && granted ? { notifications_enabled: true } : {}) }
      });
      store.setSettings(res.settings);
      if (!on) pushToast('info', 'Pomodoro off — the plain timer is back');
      else if (granted) pushToast('info', 'Pomodoro on — you will be notified when a focus block or break ends');
      else pushToast('info', 'Pomodoro on — notifications are blocked, run endings show as in-app toasts');
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function revoke(id: string) {
    // audit: failures were swallowed — a failed revocation must be visible
    try {
      await api(`/me/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function revokeOthers() {
    try {
      await api('/me/sessions/revoke-others', { method: 'POST' });
      setSessions((prev) => prev.filter((s) => s.current));
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
    store.signOut();
    go('/');
  }

  async function deleteAccount() {
    try {
      await api('/me', { method: 'DELETE' });
      location.href = '/';
    } catch (e: any) { pushToast('error', e.message); }
  }

  const timezones = supportedTimezones();
  const modalRef = useModalA11y(onClose);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal" style={{ maxWidth: 620, maxHeight: '88vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">

        <h3>Profile</h3>
        <label className="field"><span>Display name</span>
          <input className="input" defaultValue={user.name} onBlur={(e) => e.target.value !== user.name && saveProfile({ name: e.target.value })} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
          <label className="field"><span>Timezone (IANA — drives all report bucketing)</span>
            <Combobox
              ariaLabel="Timezone"
              text={tzText}
              onTextChange={setTzText}
              onPick={(tz) => {
                setTzText(tz);
                if (store.get().user?.timezone !== tz) void saveProfile({ timezone: tz });
              }}
              onBlur={() => {
                if (tzText && store.get().user?.timezone !== tzText) void saveProfile({ timezone: tzText });
              }}
              groups={[{ options: timezones.map((tz) => ({ value: tz, label: tz })) }]}
              placeholder={user.timezone}
            />
          </label>
          <label className="field"><span>Week starts on</span>
            <select className="input" value={user.week_start} onChange={(e) => saveProfile({ week_start: Number(e.target.value) })}>
              <option value={0}>Sunday</option>
              <option value={1}>Monday</option>
              <option value={2}>Tuesday</option>
              <option value={3}>Wednesday</option>
              <option value={4}>Thursday</option>
              <option value={5}>Friday</option>
              <option value={6}>Saturday</option>
            </select></label>
        </div>

        <h3 style={{ marginTop: 18 }}>Appearance</h3>
        <label className="field"><span>Theme (dark / light / follow system)</span>
          <select className="input" value={currentTheme}
            onChange={(e) => { const v = e.target.value as ThemePref; applyTheme(v, true); }}>
            <option value="system">Follow system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select></label>

        <h3 style={{ marginTop: 18 }}>Pomodoro</h3>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={settings.pomodoro.enabled}
            onChange={(e) => enablePomodoro(e.target.checked)} />
          <span>Pomodoro timer — the simple timer becomes focus blocks with break prompts (endings notify you)</span>
        </label>
        <div style={{
          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 10,
          opacity: settings.pomodoro.enabled ? 1 : 0.55
        }}>
          <label className="field"><span>Focus ({settings.pomodoro.focus_min} min)</span>
            <input type="range" min={POMODORO_LIMITS.focusMinMin} max={POMODORO_LIMITS.focusMinMax} step={5} defaultValue={settings.pomodoro.focus_min}
              onMouseUp={(e) => save({ pomodoro: { focus_min: Number((e.target as HTMLInputElement).value) } })}
              onTouchEnd={(e) => save({ pomodoro: { focus_min: Number((e.target as HTMLInputElement).value) } })}
              onKeyUp={(e) => save({ pomodoro: { focus_min: Number((e.target as HTMLInputElement).value) } })}
              aria-label="Focus minutes" /></label>
          <label className="field"><span>Break ({settings.pomodoro.break_min} min)</span>
            <input type="range" min={POMODORO_LIMITS.breakMinMin} max={POMODORO_LIMITS.breakMinMax} defaultValue={settings.pomodoro.break_min}
              onMouseUp={(e) => save({ pomodoro: { break_min: Number((e.target as HTMLInputElement).value) } })}
              onTouchEnd={(e) => save({ pomodoro: { break_min: Number((e.target as HTMLInputElement).value) } })}
              onKeyUp={(e) => save({ pomodoro: { break_min: Number((e.target as HTMLInputElement).value) } })}
              aria-label="Break minutes" /></label>
          <label className="field"><span>Auto-start next focus</span>
            <select className="input" value={settings.pomodoro.auto_start ? '1' : '0'}
              onChange={(e) => save({ pomodoro: { auto_start: e.target.value === '1' } })}>
              <option value="0">Off (recommended)</option>
              <option value="1">On (still counts tracked time only)</option>
            </select></label>
        </div>
        <label className="field"><span>Recovery discard grace (minutes — suggested end time when discarding an old timer)</span>
          <input className="input" type="number" min={0} max={240} defaultValue={settings.grace_min}
            onBlur={(e) => Number(e.target.value) !== settings.grace_min && save({ grace_min: Number(e.target.value) })} /></label>

        <h3 style={{ marginTop: 18 }}>Notifications</h3>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={settings.notifications_enabled}
            onChange={(e) => enableNotifications(e.target.checked)} />
          <span>Browser notifications for pomodoro phase changes (permission asked only when you enable this)</span>
        </label>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={settings.sound_enabled}
            onChange={(e) => save({ sound_enabled: e.target.checked })} />
          <span>Notification sound</span>
        </label>
        {notifState === 'denied' && <p className="error-text">Notification permission is blocked in the browser.</p>}

        <h3 style={{ marginTop: 18 }}>Security — active sessions</h3>
        <div className="sessions-list">
          <table className="tbl">
            <thead><tr><th>Device</th><th>IP</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{deviceLabel(s.user_agent)} {s.current && <span className="badge timer">this device</span>}</td>
                  <td className="muted">{s.ip || '—'}</td>
                  <td>{new Date(s.last_seen_at).toLocaleString()}</td>
                  <td><button className="btn ghost small" disabled={s.current} onClick={() => revoke(s.id)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn small" style={{ marginTop: 8 }} onClick={revokeOthers}>Sign out all other devices</button>
        <button className="btn small" style={{ marginTop: 8, marginLeft: 8 }} onClick={signOut}>Sign out</button>

        {user.role === 'admin' && <AdminPanel />}

        <h3 style={{ marginTop: 18 }}>Data</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Export everything (JSON + sessions CSV) — the round-trip export → import preserves ids (FR-D1).
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="btn" href="/api/export?format=json" download>Export JSON</a>
          <a className="btn" href="/api/export?format=csv" download>Export sessions CSV</a>
        </div>

        <h3 style={{ marginTop: 22, color: 'var(--danger)' }}>Danger zone</h3>
        <p className="muted">Deletes your account and every project, task, checklist, dependency and session. This cannot be undone after backups age out (30 days).</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ width: 240 }} placeholder="Type DELETE to confirm"
            value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} aria-label="Confirm account deletion" />
          <button className="btn danger" disabled={confirmDelete !== 'DELETE'} onClick={deleteAccount}>Delete account</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
        <p className="muted" style={{ fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
          TimeKeep v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}

function deviceLabel(ua: string): string {
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/macintosh/i.test(ua)) return 'macOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/linux/i.test(ua)) return 'Linux';
  return ua.slice(0, 28) || 'Unknown device';
}

/** Admin user management (audit: this lived inline in the six-job settings
 *  modal — it is its own surface with its own state and API calls). */
function AdminPanel() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');

  useEffect(() => {
    void api<{ users: AdminUserRow[] }>('/admin/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, []);

  async function createUser() {
    setBusy(true);
    try {
      await api('/admin/users', {
        method: 'POST',
        body: { username: newUsername, name: newName || undefined, email: newEmail || undefined, password: newPassword }
      });
      const r = await api<{ users: AdminUserRow[] }>('/admin/users');
      setUsers(r.users);
      setNewUsername(''); setNewName(''); setNewEmail(''); setNewPassword('');
      pushToast('info', `User "${newUsername}" created — they'll set their own password at first login`);
    } catch (e: any) { pushToast('error', e.message); } finally { setBusy(false); }
  }

  async function setActive(u: AdminUserRow, active: 0 | 1) {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active } });
      setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, active } : x)));
      pushToast('info', active ? `User "${u.username}" can sign in again` : `User "${u.username}" is signed out and blocked`);
    } catch (e: any) { pushToast('error', e.message); }
  }

  async function resetPassword(u: AdminUserRow) {
    setBusy(true);
    try {
      await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: resetPw } });
      setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, must_change_password: true } : x)));
      setResetFor(null); setResetPw('');
      pushToast('info', `Temporary password set for "${u.username}" — they must change it at next login`);
    } catch (e: any) { pushToast('error', e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <h3 style={{ marginTop: 18 }}>Admin — users</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Accounts are created here only — there is no sign-up form. New users must set their own
        password at first login. Deactivating signs a user out everywhere and blocks sign-in;
        their data is kept.
      </p>
      <div className="sessions-list">
        <table className="tbl">
          <thead><tr><th>User</th><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.username} {u.role === 'admin' && <span className="badge timer">admin</span>}</td>
                <td className="muted">{u.name || '—'}</td>
                <td>
                  {!u.active ? <span className="badge" style={{ background: 'var(--danger)', color: '#fff' }}>deactivated</span>
                    : u.must_change_password ? <span className="badge timer">temp password</span>
                    : <span className="muted">active</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.role !== 'admin' && (
                    <>
                      <button className="btn ghost small" disabled={busy}
                        onClick={() => setActive(u, u.active ? 0 : 1)}>
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button className="btn ghost small" disabled={busy}
                        onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(''); }}>
                        Reset password
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resetFor && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="input" style={{ width: 240 }} type="password" placeholder={`Temporary password (min ${MIN_PASSWORD} chars)`}
              value={resetPw} onChange={(e) => setResetPw(e.target.value)} aria-label="Temporary password" />
            <button className="btn small" disabled={busy || resetPw.length < MIN_PASSWORD}
              onClick={() => { const u = users!.find((x) => x.id === resetFor); if (u) void resetPassword(u); }}>
              Set
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, marginTop: 12 }}>
        <label className="field"><span>Username (new user)</span>
          <input className="input" value={newUsername} onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
            placeholder="e.g. sara" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        <label className="field"><span>Display name (optional)</span>
          <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
        <label className="field"><span>Email (optional — only for password-reset mail)</span>
          <input className="input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></label>
        <label className="field"><span>Initial password (min {MIN_PASSWORD} characters)</span>
          <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" /></label>
      </div>
      <button className="btn small primary" disabled={busy || newUsername.length < 2 || newPassword.length < MIN_PASSWORD}
        onClick={createUser}>Add user</button>
    </>
  );
}

function supportedTimezones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch { return ['UTC']; }
}

