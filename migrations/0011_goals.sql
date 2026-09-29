-- 0011: goals (v0.6.0) — user-owned, additive (new table only; see the D1
-- gotcha in AGENTS.md about table rebuilds). Status is DERIVED (archived_at +
-- ends_at + the live done-states of the scope refs), so there is deliberately
-- no completed_at column — un-checking a scope item re-activates a completed
-- goal. scope is a JSON array of "kind:id" refs ("project:ULID", "task:ULID",
-- "subtask:ULID"); per AGENTS.md the per-user cap is enforced inside the
-- INSERT (routes/goals.ts), not by a prior COUNT.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
  direction TEXT NOT NULL CHECK (direction IN ('at_least', 'at_most')),
  target_minutes INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 20160),
  scope TEXT NOT NULL CHECK (length(scope) <= 4000),
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_goals_user ON goals(user_id, created_at);
