# Changelog

## 0.3.0 — 2026-09-23

Everything since 0.2.0:

- **Chat dock.** Group chats moved out of the group detail into collapsible
  docked windows at the bottom-right — one window per group (launcher 💬 with
  unread badges, ≤3 expanded at once, state persisted). Message lists scroll,
  lazy-load older history at the top, and autoscroll on new messages; live
  delivery, edit/delete and read-marking unchanged.
- **Groups UI.** Group detail is a header (color, name, role, member count,
  Chat/Leave/Delete) plus internal tabs — Projects | Members | Invites.
- **Dashboard drill-downs.** The donut is separated by subtask (project-colored
  slices, no legend, hover = Task ▸ Subtask + time; `/reports/summary`
  gained `donut_subtasks[]`). New daily summary card backed by
  `GET /reports/day`: ‹ Prev · date · Next › navigation, day total with a live
  running-session boost, per-project minutes, per-task rows with subtask
  breakdown.
- **Tasks view.** The main content area lists projects and tasks newest-first
  (creation recency) — independent of the sidebar's manual ordering. Rows
  select, toggle done, start/stop the timer, add tasks/subtasks, and expand
  subtasks (toggle + per-subtask timer).
- **Shortcuts.** `P` (new project) and `S` (new subtask) now show kbd hints on
  the buttons; new global `R` (and a ▶ Resume button in the idle timer bar)
  continues tracking on the most recently tracked task. Help overlay corrected
  (views are 1–5) and documents all of it.
- **Map.** Dependency edges carry arrowheads (prerequisite → dependent,
  warn-colored when unmet) and attach to the sides actually facing each other;
  wiring flipped to match the right-side handle — dragging A's port onto B
  means B depends on A, the arrow following the drag.
- **Log pagination.** `GET /sessions` is page-based (`page`, `page_size`,
  `total`); the log renders Prev/Next with first/last jumps and a page
  indicator, filters reset to page 1, no more "Load more" DOM accumulation.
- **Login crash fix.** Logging in from an expired session rendered the shell
  before boot filled the profile → "Something broke" until refresh; the app
  now waits for the user profile. The error-boundary fallback shows the
  exception message.
- **Sign-out + mobile sidebar.** ⏻ sign-out button in the topbar (revokes the
  session, always clears local state). The off-canvas sidebar can be hidden
  again on narrow screens (tap-outside backdrop + in-drawer close button).
- **Tooling/docs.** Version strings standardized to `x.x.x` / `x.x.x.devN`;
  commit messages are `<version> — <description>`; `AUDIT.md` removed (its
  fixes shipped); new focused e2e `e2e/pagination-day-check.mjs`.
