// App shell: routing (views are URL routes — /, /log, /map, /dashboard), responsive
// layout, global keyboard shortcuts (FR-U4), quick-find (FR-T6), toasts, offline
// banner (FR-N5), recovery banner (FR-S3), and the password-reset/verify flows.
import { useEffect, useState, useCallback, Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { store, useStore, pushToast, dismissToast, go, pathForView, viewFromPath } from './lib/store';
import type { AppState } from './lib/store';
import { api } from './lib/api';
import { applyTheme, currentThemePref } from './lib/theme';
import { useModalA11y } from './lib/modal';
import AuthView from './views/AuthView';
import ChangePasswordView from './views/ChangePasswordView';
import ResetPasswordView from './views/ResetPasswordView';
import VerifyEmailView from './views/VerifyEmailView';
import JoinGroupView from './views/JoinGroupView';
import TreeSidebar from './views/TreeSidebar';
import LogView from './views/LogView';
import MapView from './views/MapView';
import SocialView from './views/SocialView';
import SettingsView from './views/SettingsView';
import TimerBar from './components/TimerBar';
import QuickFind from './components/QuickFind';

// chart.js is only used here — lazy-loading roughly halves the initial bundle
// (audit: 441 KB eager for a time tracker)
const DashboardView = lazy(() => import('./views/DashboardView'));

/** Audit: no error boundary anywhere — a render exception white-screened the SPA. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(JSON.stringify({ evt: 'render_error', message: String(error?.message ?? error) })); }
  render() {
    if (this.state.error) {
      return (
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Something broke</h2>
            <p className="muted">A rendering error occurred. Your data is safe — the running timer kept ticking server-side.</p>
            <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const booted = useStore((s) => s.booted);
  const authed = useStore((s) => s.authed);
  const user = useStore((s) => s.user);
  const route = useRoute();

  return (
    <ErrorBoundary>
      {!booted ? <div className="auth-wrap"><div className="muted">Loading…</div></div>
        : route === '/reset' ? <ResetPasswordView />
        : route === '/verify' ? <VerifyEmailView />
        : route.startsWith('/join/') ? (authed
            ? <JoinGroupView token={route.slice('/join/'.length)} />
            : <AuthView />)   // sign in first, then re-open the invite link
        : (!authed || route === '/login') ? <AuthView />
        // forced password change: nothing else in the app is reachable until it's done
        : user?.must_change_password ? <ChangePasswordView />
        : <Shell route={route} />}
    </ErrorBoundary>
  );
}

function useRoute(): string {
  const [route, setRoute] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setRoute(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}

function Shell({ route }: { route: string }) {
  const view = useStore((s) => s.view);
  const connection = useStore((s) => s.connection);
  const user = useStore((s) => s.user)!;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(route === '/settings');

  // views are routes: URL → store state (back/forward buttons work)
  useEffect(() => {
    const v = viewFromPath(route);
    if (v && v !== store.get().view) store.setView(v);
    setSettingsOpen(route === '/settings');
  }, [route]);

  // keyboard shortcuts (FR-U4): N, T, F2 handled in TreeSidebar scope; global: 1-4, Ctrl+K, ?, T.
  // Suppressed while a modal is open (audit: shortcuts fired through modals).
  const onKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    if (quickFindOpen || helpOpen || settingsOpen) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setQuickFindOpen((v) => !v);
      return;
    }
    if (e.key === '?') { setHelpOpen((v) => !v); return; }
    if (e.key >= '1' && e.key <= '5') {
      const views = ['tree', 'log', 'map', 'dashboard', 'social'] as const;
      store.navigateToView(views[Number(e.key) - 1]!);
      return;
    }
  }, [quickFindOpen, helpOpen, settingsOpen]);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className="app">
      <a className="visually-hidden" href="#main-content">Skip to content</a>
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Projects and tasks">
        <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
          <strong style={{ flex: 1 }}>TimeKeep</strong>
          <button className="icon-btn" title="Quick find (Ctrl+K)" aria-label="Quick find"
            onClick={() => setQuickFindOpen(true)}>⌕</button>
          <button className="icon-btn" title="Settings" aria-label="Settings"
            onClick={() => { setSettingsOpen(true); go('/settings'); }}>⚙</button>
        </div>
        <TreeSidebar onClose={() => setSidebarOpen(false)} />
      </aside>

      <div className="main" id="main-content">
        <header className="topbar">
          {/* mobile-only hamburger: the off-canvas sidebar's only toggle */}
          <button className="btn ghost sidebar-toggle" aria-label="Toggle project list"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}>☰</button>
          <TimerBar />
          <span className={`conn-dot ${connection}`} role="img"
            aria-label={`Connection: ${connection}`} title={`Connection: ${connection}`} />
          <span className="muted" style={{ fontSize: 12.5 }} title={`Signed in as ${user.username}`}>
            {user.name || user.username}
          </span>
        </header>

        {connection === 'offline' && (
          <div className="banner warn" role="status">
            You're offline — changes are blocked until the connection returns. The running timer keeps ticking.
          </div>
        )}
        {/* legacy accounts only — admin-created users are pre-verified and have no mailbox */}
        {user.email.includes('@') && user.email_verified_at === null && (
          <div className="banner" role="status">
            Please verify your email — check your inbox for the verification link.
            <button className="btn small" onClick={resendVerification}>Resend</button>
          </div>
        )}

        <nav className="view-tabs" role="tablist" aria-label="Views">
          {(['tree', 'log', 'map', 'dashboard', 'social'] as const).map((v, i) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => store.navigateToView(v)}>
              {labelFor(v)} <span aria-hidden> ({i + 1})</span>
            </button>
          ))}
        </nav>

        <div className="content" style={view === 'map' ? { padding: 12, display: 'flex', flexDirection: 'column' } : undefined}>
          {view === 'tree' && <TreeMain />}
          {view === 'log' && <LogView />}
          {view === 'map' && <MapView />}
          {view === 'social' && <SocialView />}
          {view === 'dashboard' && (
            <Suspense fallback={<div className="muted" style={{ padding: 24 }}>Loading charts…</div>}>
              <DashboardView />
            </Suspense>
          )}
        </div>
      </div>

      {quickFindOpen && <QuickFind onClose={() => setQuickFindOpen(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {settingsOpen && (
        <SettingsView
          onClose={() => { setSettingsOpen(false); if (route === '/settings') navigateHome(); }}
          currentTheme={currentThemePref()}
        />
      )}
      <Toasts />
    </div>
  );
}

function labelFor(v: string): string {
  return v === 'tree' ? 'Tasks' : v === 'log' ? 'Log' : v === 'map' ? 'Map' : v === 'dashboard' ? 'Dashboard' : 'Social';
}

function navigateHome(): void {
  go(pathForView(store.get().view));
}

function TreeMain() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const project = projects.find((p) => p.id === selectedProjectId);
  return (
    <div>
      <div className="card">
        <h3>{project ? project.name : 'Projects'}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Your projects and tasks live in the sidebar — pick a task and press <span className="kbd">T</span> to start
          tracking, or use the timer bar above. Open the <b>Map</b> to wire dependencies, or the <b>Dashboard</b> for
          live charts. Everything syncs to every signed-in device within a second.
        </p>
        {!project && <p className="muted">Create your first project with the ＋ button in the sidebar.</p>}
      </div>
      <QuickStart />
    </div>
  );
}

function QuickStart() {
  const tasks = useStore((s) => s.tasks);
  const recentIds = useStore((s) => s.recentTaskIds);
  // most recently *tracked* tasks first (bootstrap supplies the order);
  // tasks never tracked keep bootstrap (position) order behind them
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  const recent = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = rank.get(a.t.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.t.id) ?? Number.POSITIVE_INFINITY;
      return ra !== rb ? ra - rb : a.i - b.i;
    })
    .slice(0, 6)
    .map(({ t }) => t);
  if (recent.length === 0) return null;
  return (
    <div className="card">
      <h3>Jump back in</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {recent.map((t) => (
          <button key={t.id} className="btn small" onClick={async () => {
            try {
              store.selectTask(t.id);
              await store.startTimer(t.id);
            } catch (e: any) {
              pushToast('error', e.message);
            }
          }}>▶ {t.name}</button>
        ))}
      </div>
    </div>
  );
}

async function resendVerification(): Promise<void> {
  try {
    // dedicated verification-resend endpoint
    await api('/auth/resend-verification', { method: 'POST' });
    pushToast('info', 'Verification email sent — check your inbox');
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const modalRef = useModalA11y(onClose);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <table className="tbl"><tbody>
          <tr><td><span className="kbd">P</span></td><td>New project</td></tr>
          <tr><td><span className="kbd">N</span></td><td>New task (context-aware)</td></tr>
          <tr><td><span className="kbd">S</span></td><td>New subtask on the selected task</td></tr>
          <tr><td><span className="kbd">T</span></td><td>Toggle timer on selection</td></tr>
          <tr><td><span className="kbd">F2</span></td><td>Rename selection</td></tr>
          <tr><td><span className="kbd">Delete</span></td><td>Delete with 5s undo</td></tr>
          <tr><td><span className="kbd">Ctrl/Cmd</span> + <span className="kbd">K</span></td><td>Quick find</td></tr>
          <tr><td><span className="kbd">1</span>–<span className="kbd">4</span></td><td>Switch views</td></tr>
          <tr><td><span className="kbd">Enter</span></td><td>Open / commit</td></tr>
          <tr><td><span className="kbd">?</span></td><td>This overlay</td></tr>
        </tbody></table>
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          <span className="grow">{t.message}</span>
          {t.kind === 'undo' && t.undoPayload && (
            <button className="btn small primary" onClick={async () => {
              try { await t.undoPayload!(); } catch (e: any) { pushToast('error', e.message); }
              dismissToast(t.id);
            }}>Undo</button>
          )}
          <button className="btn ghost small" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
