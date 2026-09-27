-- 0010: tombstones, so deleting shared metadata cannot destroy someone's
-- history (INV-06).
--
-- Before: `time_sessions.task_id REFERENCES tasks(id) ON DELETE CASCADE`, so
-- deleting a GROUP task (or a group project) cascade-deleted the time_sessions
-- of every member who had tracked on it — one user's destructive action erasing
-- another user's historical records. Reports and exports are the point of the
-- app; that is not a data-integrity posture.
--
-- After: nothing is cascade-deleted through this path. A delete sets
-- `deleted_at`; the row stays, keeps its name, and the sessions that reference
-- it keep their duration. Every LIVE listing/editing path filters
-- `deleted_at IS NULL`, so a tombstone is invisible everywhere except history.
--
-- `time_sessions.task_name` snapshots the task's name at write time, so a report
-- over a task that was later renamed — or tombstoned — still renders something
-- intelligible. It is a fallback only: while the task row exists, reports use
-- its CURRENT name, exactly as before.
--
-- Additive only (no table rebuilds — see 0003 and AGENTS.md), which is what
-- makes this safe to apply to a live database. `projects` keeps its inline
-- UNIQUE(user_id, name): a tombstoned project still holds its name, and a create
-- that collides with one renames the tombstone out of the way in the same batch
-- (routes/projects.ts) rather than rebuilding the table to swap the index.
ALTER TABLE tasks ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE time_sessions ADD COLUMN task_name TEXT;

-- Backfill the snapshot from the task that still exists. Sessions whose task is
-- gone (only possible if a row predates the FK, or was orphaned by an old
-- migration) keep a NULL snapshot and fall back to the session id in reports.
UPDATE time_sessions
SET task_name = (SELECT name FROM tasks WHERE tasks.id = time_sessions.task_id)
WHERE task_name IS NULL;

-- Partial indexes for the live-listing paths: the tombstoned tail is never
-- scanned by a list query, which is most of them. (Sessions are NOT tombstoned
-- — a session is the user's own record and they delete it outright — so there is
-- no partial index on that table.)
CREATE INDEX idx_tasks_live ON tasks(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_live ON projects(user_id, position) WHERE deleted_at IS NULL;
