# 0.5.2

- **Context-aware timer shortcut** — `R` now stops the active timer when one is
  running and resumes the most recently tracked task when idle. The sidebar's
  resume control changes to a stop control, and the most recent task remains
  available after the timer stops.
- **Sidebar layout** — the project list and the selected project's task list
  now occupy separate independently scrollable panes. Long projects no longer
  push the rest of the sidebar down.
- **Compact row actions** — project and task secondary actions are consolidated
  into mini menus on every screen. Menus render outside the sidebar overflow,
  so they remain usable in constrained desktop and tablet windows.
- **Truncated text** — overflowing labels auto-scroll horizontally on hover
  while preserving the existing ellipsis and touch-friendly two-line clamp.
- **Release discipline** — AGENTS.md now requires an annotated `vX.Y.Z` tag
  for every non-dev release commit. Dev iterations remain untagged and do not
  trigger the release-only CD workflow.
- **Documentation** — responsive UI, truncation, sidebar menu, and release
  deployment behavior are kept in sync with the implementation.
