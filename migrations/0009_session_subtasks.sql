-- 0009: subtask attribution on sessions.
--  - a session tracks work on ONE subtask (0..1 — NULL = task-level time)
--  - deleting a subtask keeps the tracked time: ON DELETE SET NULL (sessions
--    are the precious records — never cascade-deleted via their subtask)
--  - active_timers mirrors it so a DO eviction reconstructs the running
--    session with its subtask intact
--  - /restore must insert subtasks BEFORE sessions (FK order)
ALTER TABLE time_sessions ADD COLUMN subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_subtask ON time_sessions(subtask_id);
ALTER TABLE active_timers ADD COLUMN subtask_id TEXT;
