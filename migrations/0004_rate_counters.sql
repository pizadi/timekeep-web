-- Atomic fixed-window rate-limit counters (NFR-3).
-- Replaces the KV read-modify-write counters, whose get→increment→put race
-- let concurrent requests exceed the configured limits. `rateLimitHit` now
-- does ONE atomic upsert … RETURNING, which D1 serializes per row.
CREATE TABLE rate_counters (
  key TEXT PRIMARY KEY,          -- `${rule}:${subject}:${window}`
  n INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL, -- floored window epoch-ms (informational)
  expires_at INTEGER NOT NULL    -- pruned daily by cron
);
CREATE INDEX idx_rate_counters_expires ON rate_counters (expires_at);
