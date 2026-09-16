-- TimeKeep Web — initial schema (spec §5.2)
-- All timestamps are epoch-ms UTC. Every table is user-scoped (NFR-3).
-- D1 enforces foreign keys; cascades implement hard account deletion (FR-A8).

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT,                          -- NULL for OAuth-only accounts (future)
  name           TEXT NOT NULL DEFAULT '',
  timezone       TEXT NOT NULL DEFAULT 'UTC',   -- IANA
  week_start     INTEGER NOT NULL DEFAULT 1 CHECK (week_start IN (0,1)),
  theme          TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  email_verified_at INTEGER,
  totp_secret    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE oauth_accounts (
  provider     TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_uid)
);

CREATE TABLE auth_sessions (           -- opaque session cookies, hashed at rest (FR-A6)
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify','reset','magic')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4f8cff',
  archived   INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX idx_projects_user ON projects(user_id, position);

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES tasks(id) ON DELETE CASCADE, -- root tasks: NULL
  name       TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, position);
CREATE INDEX idx_tasks_user    ON tasks(user_id);

CREATE TABLE subtasks (                -- exactly one level (FR-T3)
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_subtasks_task ON subtasks(task_id, position);

CREATE TABLE task_dependencies (       -- DAG edges: same project, root tasks only (FR-M5)
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_deps_on   ON task_dependencies(depends_on_id);
CREATE INDEX idx_deps_user ON task_dependencies(user_id);

CREATE TABLE time_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,         -- epoch ms UTC
  ended_at   INTEGER,                  -- NULL only while running (<=1 per user)
  source     TEXT NOT NULL DEFAULT 'timer'
             CHECK (source IN ('timer','manual','pomodoro')),
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_start ON time_sessions(user_id, started_at);
CREATE INDEX idx_sessions_task       ON time_sessions(task_id, started_at);
CREATE UNIQUE INDEX idx_sessions_running
  ON time_sessions(user_id) WHERE ended_at IS NULL;   -- the single-timer invariant (FR-S1)

CREATE TABLE active_timers (           -- recovery mirror of UserHub state (FR-S3)
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES time_sessions(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  pomo_state TEXT NOT NULL DEFAULT ''  -- JSON: phase, accumulated focus ms
);

CREATE TABLE layout (                  -- map node positions (FR-M8)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  x REAL NOT NULL, y REAL NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL DEFAULT '{}'   -- JSON: pomodoro, sound, notifications, grace…
);

CREATE TABLE sync_log (                -- event log for reconnect deltas (FR-N3); pruned daily
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,              -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sync_user ON sync_log(user_id, id);
