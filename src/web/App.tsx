// App shell: routing (views are URL routes — /, /log, /map, /dashboard), responsive
// layout, global keyboard shortcuts (FR-U4), quick-find (FR-T6), toasts, offline
// banner (FR-N5), recovery banner (FR-S3), and the password-reset/verify flows.
import { useEffect, useState, useCallback, Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { store, useStore, pushToast, dismissToast, go, pathForView, viewFromPath } from './lib/store';
import { api } from './lib/api';
import { currentThemePref } from './lib/theme';
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
import ChatDock from './components/ChatDock';
import TimerBar from './components/TimerBar';
import QuickFind from './components/QuickFind';
import HoverScrollText from './components/HoverScrollText';
import {
  addProject,
  addTask,
  addSubtask,
  toggleTaskDone,
  toggleSubtaskDone,
  toggleTaskTimer,
  toggleSubtaskTimer,
} from './lib/actions';
import { useHasHover } from './lib/responsive';
import { GROUP_PERMS, parseGroupPerms, type GroupPerm } from '../shared/constants';
import type { Project, Task } from './lib/store';

// chart.js is only used here — lazy-loading roughly halves the initial bundle
// (audit: 441 KB eager for a time tracker)
const DashboardView = lazy(() => import('./views/DashboardView'));

/** Audit: no error boundary anywhere — a render exception white-screened the SPA. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(JSON.stringify({ evt: 'render_error', message: String(error?.message ?? error) }));
  }
  render() {
    if (this.state.error) {
      return (
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Something broke</h2>
            <p className="muted">
              A rendering error occurred. Your data is safe — the running timer kept ticking server-side.
            </p>
            {/* message surfaced so a render bug is diagnosable from the screen alone */}
            <p className="error-text">{this.state.error.message}</p>
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
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
      {!booted ? (
        <div className="auth-wrap">
          <div className="muted">Loading…</div>
        </div>
      ) : route === '/reset' ? (
        <ResetPasswordView />
      ) : route === '/verify' ? (
        <VerifyEmailView />
      ) : route.startsWith('/join/') ? (
        authed ? (
          <JoinGroupView token={route.slice('/join/'.length)} />
        ) : (
          <AuthView />
        ) // sign in first, then re-open the invite link
      ) : !authed || route === '/login' ? (
        <AuthView />
      ) : // login flips `authed` while the boot it triggers is still in flight —
      // Shell needs the profile, so hold on "Loading…" until `user` exists
      // (without this gate Shell crashed on `user.name` → "Something broke"
      // after every login from an expired session)
      !user ? (
        <div className="auth-wrap">
          <div className="muted">Loading…</div>
        </div>
      ) : // forced password change: nothing else in the app is reachable until it's done
      user?.must_change_password ? (
        <ChangePasswordView />
      ) : (
        <Shell route={route} />
      )}
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
  const hasHover = useHasHover(); // keyboard-shortcut hints only make sense with a keyboard
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(route === '/settings');

  // views are routes: URL → store state (back/forward buttons work)
  useEffect(() => {
    const v = viewFromPath(route);
    if (v && v !== store.get().view) store.setView(v);
    setSettingsOpen(route === '/settings');
  }, [route]);

  // keyboard shortcuts (FR-U4): N, T, F2 handled in TreeSidebar scope; global: 1-4, Ctrl+K, ?, T.
  // Suppressed while a modal is open (audit: shortcuts fired through modals).
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      if (quickFindOpen || helpOpen || settingsOpen) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickFindOpen((v) => !v);
        return;
      }
      if (e.key === '?') {
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key >= '1' && e.key <= '5') {
        const views = ['tree', 'log', 'map', 'dashboard', 'social'] as const;
        store.navigateToView(views[Number(e.key) - 1]!);
        return;
      }
    },
    [quickFindOpen, helpOpen, settingsOpen],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className="app">
      <a className="visually-hidden" href="#main-content">
        Skip to content
      </a>
      {/* drawer backdrop (narrow screens): tap anywhere outside to dismiss */}
      {sidebarOpen && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Projects and tasks">
        <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
          <strong style={{ flex: 1 }}>TimeKeep</strong>
          <button
            className="icon-btn"
            title="Quick find (Ctrl+K)"
            aria-label="Quick find"
            onClick={() => setQuickFindOpen(true)}
          >
            ⌕
          </button>
          <button className="icon-btn" title="About" aria-label="About TimeKeep" onClick={() => setAboutOpen(true)}>
            ⓘ
          </button>
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => {
              setSettingsOpen(true);
              go('/settings');
            }}
          >
            ⚙
          </button>
          {/* narrow screens only: the fixed drawer covers the main topbar's
              hamburger once open, so the drawer needs its own close button */}
          <button
            className="icon-btn sidebar-close"
            aria-label="Close project list"
            onClick={() => setSidebarOpen(false)}
          >
            ✕
          </button>
        </div>
        <TreeSidebar onClose={() => setSidebarOpen(false)} />
      </aside>

      <div className="main" id="main-content">
        <header className="topbar">
          {/* mobile-only hamburger: the off-canvas sidebar's only toggle */}
          <button
            className="btn ghost sidebar-toggle"
            aria-label="Toggle project list"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <TimerBar />
          <span
            className={`conn-dot ${connection}`}
            role="img"
            aria-label={`Connection: ${connection}`}
            title={`Connection: ${connection}`}
          />
          <span className="muted topbar-user" style={{ fontSize: 12.5 }} title={`Signed in as ${user.username}`}>
            {user.name || user.username}
          </span>
          <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => void signOutNow()}>
            ⏻
          </button>
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
            <button className="btn small" onClick={resendVerification}>
              Resend
            </button>
          </div>
        )}

        <nav className="view-tabs" role="tablist" aria-label="Views">
          {(['tree', 'log', 'map', 'dashboard', 'social'] as const).map((v, i) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => store.navigateToView(v)}>
              {labelFor(v)} {hasHover && <span aria-hidden> ({i + 1})</span>}
            </button>
          ))}
        </nav>

        <div
          className="content"
          style={view === 'map' ? { padding: 12, display: 'flex', flexDirection: 'column' } : undefined}
        >
          {view === 'tree' && <TreeMain />}
          {view === 'log' && <LogView />}
          {view === 'map' && <MapView />}
          {view === 'social' && <SocialView />}
          {view === 'dashboard' && (
            <Suspense
              fallback={
                <div className="muted" style={{ padding: 24 }}>
                  Loading charts…
                </div>
              }
            >
              <DashboardView />
            </Suspense>
          )}
        </div>
      </div>

      {quickFindOpen && <QuickFind onClose={() => setQuickFindOpen(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {aboutOpen && <AboutOverlay onClose={() => setAboutOpen(false)} />}
      {settingsOpen && (
        <SettingsView
          onClose={() => {
            setSettingsOpen(false);
            if (route === '/settings') navigateHome();
          }}
          currentTheme={currentThemePref()}
        />
      )}
      <Toasts />
      <ChatDock />
    </div>
  );
}

function labelFor(v: string): string {
  return v === 'tree'
    ? 'Tasks'
    : v === 'log'
      ? 'Log'
      : v === 'map'
        ? 'Map'
        : v === 'dashboard'
          ? 'Dashboard'
          : 'Social';
}

function navigateHome(): void {
  go(pathForView(store.get().view));
}

/** Sign out: revoke the session server-side, then clear local state. The
 *  local clear happens even if the request fails (offline sign-out). */
async function signOutNow(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* session is cleared locally regardless */
  }
  store.signOut();
  go('/');
}

// Tasks view (main content area): a read-light browser over the same data the
// sidebar edits — ordered NEWEST → OLDEST (creation recency), independent of
// the sidebar's manual position ordering. Selecting a row syncs the sidebar,
// Map and log pickers; full editing (rename/move/delete) lives in the sidebar.
function TreeMain() {
  const projects = useStore((s) => s.projects);
  const groups = useStore((s) => s.groups);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const hasHover = useHasHover();

  const byNew = (a: { created_at: number }, b: { created_at: number }) => b.created_at - a.created_at;
  const personal = projects.filter((p) => !p.group_id).sort(byNew);
  const groupIds = [...new Set(projects.filter((p) => p.group_id).map((p) => p.group_id!))];

  /** My perms inside the group that owns this project (null = personal). */
  function permsFor(p: Project): GroupPerm[] | null {
    if (!p.group_id) return null;
    const g = groups.find((x) => x.id === p.group_id);
    if (!g) return null;
    return g.role === 'owner' ? [...GROUP_PERMS] : parseGroupPerms(g.perms);
  }

  return (
    <div>
      <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ flex: 1, marginBottom: 0 }}>
          Projects & tasks{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            — newest first
          </span>
        </h3>
        <button className="btn small primary" onClick={() => void addProject()}>
          ＋ Project{' '}
          <span className="kbd" style={{ marginLeft: 4 }}>
            P
          </span>
        </button>
        <button
          className="btn small"
          disabled={!selectedProjectId}
          title="New task in the selected project"
          onClick={() => selectedProjectId && void addTask(selectedProjectId)}
        >
          ＋ Task{' '}
          <span className="kbd" style={{ marginLeft: 4 }}>
            N
          </span>
        </button>
      </div>
      <QuickStart />
      {personal.map((p) => (
        <ProjectBlock
          key={p.id}
          project={p}
          canEditTasks={permsFor(p) === null || permsFor(p)!.includes('edit_tasks')}
        />
      ))}
      {groupIds.map((gid) => {
        const g = groups.find((x) => x.id === gid);
        return (
          <div key={gid}>
            <div className="tree-section-title" title="Group project — visible to current members only">
              👥 {g?.name ?? 'Group'}
            </div>
            {projects
              .filter((p) => p.group_id === gid)
              .sort(byNew)
              .map((p) => (
                <ProjectBlock key={p.id} project={p} canEditTasks={permsFor(p)?.includes('edit_tasks') ?? false} />
              ))}
          </div>
        );
      })}
      {personal.length === 0 && groupIds.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {hasHover ? (
              <>
                No projects yet — press <span className="kbd">P</span> or use ＋ Project above to create one.
              </>
            ) : (
              <>No projects yet — use ＋ Project above to create one.</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/** One project card: header + its tasks, newest first. */
function ProjectBlock({ project, canEditTasks }: { project: Project; canEditTasks: boolean }) {
  const tasks = useStore((s) => s.tasks);
  const list = tasks.filter((t) => t.project_id === project.id).sort((a, b) => b.created_at - a.created_at);
  return (
    <div className="card" style={{ padding: '8px 12px 10px' }}>
      <div
        className="row"
        role="button"
        tabIndex={0}
        style={{ paddingLeft: 4 }}
        onClick={() => store.selectProject(project.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') store.selectProject(project.id);
        }}
      >
        <span className="chip" style={{ background: project.color }} aria-hidden />
        <HoverScrollText className="grow" title={project.name}>
          <b>{project.name}</b>
          {project.archived ? <span className="muted"> (archived)</span> : ''}
        </HoverScrollText>
        <span className="muted" style={{ fontSize: 12 }} title="Created">
          {fmtCreated(project.created_at)}
        </span>
        {canEditTasks && (
          <button
            className="icon-btn"
            title="Add task (N)"
            aria-label={`Add task to ${project.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void addTask(project.id);
            }}
          >
            ＋
          </button>
        )}
      </div>
      {list.map((t) => (
        <TaskRow key={t.id} task={t} canEdit={canEditTasks} />
      ))}
      {list.length === 0 && (
        <div className="muted" style={{ padding: '2px 8px 4px 24px', fontSize: 13 }}>
          No tasks yet.
        </div>
      )}
    </div>
  );
}

/** One task row with its subtasks (expanded while selected). */
function TaskRow({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const subtasks = useStore((s) => s.subtasks);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const running = useStore((s) => s.running);
  const sbs = subtasks.filter((s) => s.task_id === task.id);
  const doneCount = sbs.filter((s) => !!s.done).length;
  const pct = sbs.length ? Math.round((doneCount / sbs.length) * 100) : null;
  const isRunning = running?.task_id === task.id;
  const selected = selectedTaskId === task.id;
  return (
    <div>
      <div
        className={`row${selected ? ' selected' : ''}`}
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        style={{ paddingLeft: 24 }}
        onClick={() => store.selectTask(task.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') store.selectTask(task.id);
        }}
      >
        {isRunning && <span className="dot-running" aria-label="tracking" />}
        <input
          type="checkbox"
          checked={!!task.done}
          aria-label={`Done: ${task.name}`}
          disabled={!canEdit}
          onClick={(e) => e.stopPropagation()}
          onChange={() => void toggleTaskDone(task)}
        />
        <HoverScrollText className={`grow ${task.done ? 'done-text' : ''}`} title={task.name}>
          {task.name}
        </HoverScrollText>
        {pct !== null && (
          <span className="sub" aria-label={`${pct}% of subtasks done`}>
            {pct}%
          </span>
        )}
        <span className="muted" style={{ fontSize: 12 }} title="Created">
          {fmtCreated(task.created_at)}
        </span>
        <button
          className="icon-btn"
          title="Timer (T)"
          aria-label={`Start timer on ${task.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void toggleTaskTimer(task.id);
          }}
        >
          {isRunning ? '■' : '▶'}
        </button>
        {canEdit && (
          <button
            className="icon-btn"
            title="Add subtask (S)"
            aria-label={`Add subtask to ${task.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void addSubtask(task.id);
            }}
          >
            ＋
          </button>
        )}
      </div>
      {selected &&
        sbs.map((sb) => (
          <div key={sb.id} className="row" style={{ paddingLeft: 42, minHeight: 26 }}>
            <input
              type="checkbox"
              checked={!!sb.done}
              aria-label={`Done: ${sb.name}`}
              disabled={!canEdit}
              onChange={() => void toggleSubtaskDone(sb)}
            />
            <HoverScrollText className={`grow ${sb.done ? 'done-text' : ''}`} title={sb.name}>
              {sb.name}
            </HoverScrollText>
            <button
              className="icon-btn"
              title="Track this subtask"
              aria-label={`Track subtask ${sb.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void toggleSubtaskTimer(task.id, sb.id);
              }}
            >
              {running?.subtask_id === sb.id ? '■' : '▶'}
            </button>
          </div>
        ))}
    </div>
  );
}

function fmtCreated(ts: number): string {
  const d = new Date(ts);
  const diffDays = Math.floor((Date.now() - ts) / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function QuickStart() {
  const tasks = useStore((s) => s.tasks);
  const recentEntries = useStore((s) => s.recentEntries);
  // most recently *tracked* tasks first (bootstrap supplies the order);
  // tasks never tracked keep bootstrap (position) order behind them
  const rank = new Map(recentEntries.map((e, i) => [e.task_id, i]));
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
          <button
            key={t.id}
            className="btn small"
            onClick={async () => {
              try {
                store.selectTask(t.id);
                // resume on the subtask this task last tracked (null → whole task)
                await store.startTimer(t.id, recentEntries.find((e) => e.task_id === t.id)?.subtask_id ?? null);
              } catch (e: any) {
                pushToast('error', e.message);
              }
            }}
          >
            ▶ {t.name}
          </button>
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
        <table className="tbl">
          <tbody>
            <tr>
              <td>
                <span className="kbd">P</span>
              </td>
              <td>New project</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">N</span>
              </td>
              <td>New task (context-aware)</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">S</span>
              </td>
              <td>New subtask on the selected task</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">T</span>
              </td>
              <td>Toggle timer on selection</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">R</span>
              </td>
              <td>Stop the timer, or resume tracking on the last task</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">F2</span>
              </td>
              <td>Rename selection</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">Delete</span>
              </td>
              <td>Delete with 5s undo</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">Ctrl/Cmd</span> + <span className="kbd">K</span>
              </td>
              <td>Quick find</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">1</span>–<span className="kbd">5</span>
              </td>
              <td>Switch views</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">Enter</span>
              </td>
              <td>Open / commit</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">?</span>
              </td>
              <td>This overlay</td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** About dialog: app identity, version (build-time injected) and project link. */
function AboutOverlay({ onClose }: { onClose: () => void }) {
  const modalRef = useModalA11y(onClose);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="About TimeKeep" onClick={onClose}>
      <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>TimeKeep</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Personal time tracking and task management — projects, checklists, dependency maps, reports and group
          collaboration.
        </p>
        <p style={{ margin: '10px 0' }}>
          Version <b>v{__APP_VERSION__}</b>
        </p>
        <p style={{ margin: '10px 0' }}>
          <a href="https://github.com/pizadi/timekeep-web" target="_blank" rel="noopener noreferrer">
            GitHub — pizadi/timekeep-web
          </a>
        </p>
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
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
            <button
              className="btn small primary"
              onClick={async () => {
                try {
                  await t.undoPayload!();
                } catch (e: any) {
                  pushToast('error', e.message);
                }
                dismissToast(t.id);
              }}
            >
              Undo
            </button>
          )}
          <button className="btn ghost small" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
