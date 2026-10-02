# 0.6.2

Three small quality-of-life features (0.6.2.dev1–dev2).

## New

- **Start dialog (`B`).** A `▶ Start` button in the idle timer bar and a
  global `B` shortcut open a keyboard-driven search: type to filter tasks AND
  subtasks, arrow keys to move, Enter to start tracking (auto-switches when a
  timer is already running). Results are ordered by tracked-work recency, so
  Enter on a fresh dialog resumes what you last worked on — hands never leave
  the keyboard. Listed in the shortcuts overlay (`?`).

## Changed

- **The Tasks (1) view sorts by work recency.** Projects rank by their most
  recently worked task, tasks within each project the same way; items never
  tracked keep the creation-recency order at the bottom. The sort updates
  live — your own timer starts reorder the view without a refetch, as do
  other devices' timer events. The sidebar keeps its manual ordering.
- **The Log paginates at 50 rows per page** (was 200) — same pager, tighter
  pages.
- **Dev environment:** Cloudflare access no longer routes through proxychains.
