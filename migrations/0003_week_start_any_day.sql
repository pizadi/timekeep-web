-- 0003: week start on any weekday (0=Sun … 6=Sat) — Islamic weeks (Sat/Sun),
-- Jewish weeks (Sun), ISO/Monday, Sunday (US), etc.
--
-- The legacy users.week_start column carries CHECK (week_start IN (0,1)) from
-- 0001. SQLite cannot alter a CHECK constraint, and a table rebuild is unsafe
-- in D1: FK enforcement is always on, RENAME rewrites child REFERENCES (D1
-- ignores PRAGMA legacy_alter_table), and DROP TABLE's implicit DELETE then
-- ON-DELETE-CASCADEs every user-owned row (verified empirically on a local DB).
-- So the widened value lives in a new column; the effective value everywhere is
-- COALESCE(week_start_dow, week_start). The 0|1 column keeps its meaning as
-- fallback for rows that never set the new one.

ALTER TABLE users ADD COLUMN week_start_dow INTEGER;
