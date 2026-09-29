# 0.6.0

Goals — the app's first "commitments" surface. A new **Goals** tab (between
Dashboard and Social) where you set a time target and hold yourself to it:
_spend **X** hours per **day/week/month** on **Z**_, Z being any mix of
projects, tasks and subtasks. Progress is measured per period, so the answer
to "am I actually keeping this up?" is a number, not a vibe. Also fixes a
test-infra papercut from 0.5.4-1.

## Goals

- **A goal is "X minutes per period on Z".** The scope Z is any mix of
  project/task/subtask refs (`goals.scope`, JSON `"kind:id"`); a project ref
  covers all its tasks, now and future. Scope may include group-project nodes
  you can track — sessions stay strictly user-owned, so only your own time
  counts. Overlapping picks are prevented at the picker: a pick already covered
  by an ancestor chip is refused with a hint, and a project pick supersedes its
  explicit descendants.
- **Direction**: `at_least` (habit — reaching X in a period is success, going
  over is beating it) or `at_most` (limit — staying under is success, going
  over is a breach). Stats phrasing adapts to the direction.
- **Partial periods are pro-rated.** The first period (goal created mid-period)
  and the final period (cut short by an optional expiry `ends_at`) both scale
  the target by covered time — a goal expiring four days into a week carries a
  4/7 target for that week. `ceil`, minimum one minute.
- **Completion is derived, never stored.** There is no `completed_at` column
  and nothing hooks task toggles: `goalStatus()` reads `archived_at`, `ends_at`
  and the live done-states of the scope refs, so un-checking a scope item
  re-activates a completed goal. A fully-tombstoned scope can never complete —
  the card shows a "scope deleted" warning instead. Expiry and archive (with
  un-archive) round out the lifecycle; delete is a hard DELETE (nothing
  references goals; the client's undo re-creates from the returned row).
- **Progress is server-side only.** `GET /api/goals/progress` builds each
  goal's period windows with the same `Intl` engine as reports (profile
  timezone, week start) and pushes them into SQL via `json_each()` — clients
  receive window buckets and aggregate stats (hit rate, current/best streak,
  average, overshoot count/amount, total), never session rows. The running
  session is included, clipped to `now`, and all goals compute in one
  `DB.batch` (two statements per goal).
- **The per-user cap (30) is enforced inside the INSERT** — guarded statement,
  `meta.changes` checked — so it cannot be raced (audit 🟡2 discipline).
- **Period-end notifications are client-side** (`lib/goalNotify.ts`): when a
  period boundary passes while the app is open, progress is refetched and one
  browser notification per affected goal fires (met/missed) — only with the
  Settings toggle on and permission already granted; nothing requests
  permission here.
- **UI**: goal cards with the current-period bar, streaks and stats; a
  per-goal ✓/✗ window strip with tooltips; an editor modal whose scope picker
  is the shared Combobox (search + grouped suggestions + removable chips);
  themed −/+ steppers on the target fields (native number spinners are
  unthemeable and now hidden app-wide); a collapsed "Completed & past goals"
  section. Keyboard shortcuts shift: the views are now `1`–`6` with Social on 6.

## Tests & docs

- `test/goals.test.ts` locks the pure core (period windows, week alignment,
  DST-length days, pro-rating, status precedence, stats, labels); new
  `e2e/goals-test.mjs` covers the API end-to-end (progress numbers, pro-rating,
  derived completion + re-activation, archive, scope-ref validation, the
  guarded cap, sync events) and joins `run-e2e.sh` as script 12 of 15.
- Architecture docs and AGENTS.md describe the goals surface.

## Fixes

- `0.5.4-1` — the migration unit test created its scratch dir with `mkdtemp`
  under `.work/` without creating `.work/` first; a fresh CI checkout has no
  `.work/` (gitignored), so the suite failed with ENOENT. The suite now creates
  it before `mkdtemp`.
