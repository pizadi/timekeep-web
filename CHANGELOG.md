# 0.5.1

Responsive overhaul — the app now works properly on phones and adapts to any
screen size:

- **Responsive foundations** — three width tiers (< 640 phone, 640–1023
  tablet with an off-canvas sidebar drawer, ≥ 1024 desktop); a touch-target
  scale (44px-class buttons and rows) with 16px inputs on touch devices (no
  more iOS focus zoom); `dvh` app shell; safe-area insets for the topbar,
  toasts and chat dock; hover effects gated behind `(hover: hover)`.
- **A touch path for everything** — sidebar rows collapse secondary actions
  (rename, color, reorder, visibility, archive, delete) into a per-row ⋯
  menu on narrow screens; the Map gains pinch zoom, ＋/− zoom buttons and a
  per-node ⋯ action menu (right-click no longer needed); the timer bar's
  idle hint switches to "tap ▶" on touch; keyboard-hint chips and view-tab
  shortcut hints are hidden on touch.
- **Phone layouts** — modals render as full-screen sheets; the session log
  renders as stacked cards instead of its 8-column table; filter toolbars
  become flexible grids; the dashboard bar chart keeps a legible width and
  scrolls inside its card; report tables scroll horizontally; the topbar
  compacts (account name hidden).
- **Truncation policy** — truncated text unwraps fully on hover (desktop),
  clamps to two visible lines on touch, and every truncation site carries a
  tooltip; nothing is lost to "…" without recourse.
- **About dialog** — a new ⓘ button in the sidebar topbar shows the app
  name, the running version and a link to the GitHub repository.
- **Docs** — `docs/architecture.md` documents the responsive & touch UI
  system (tiers, pointer classes, interaction matrix, truncation policy).
