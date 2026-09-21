-- 0007: social layer, phase 3 — group chat.
--  - ULID id doubles as the lexicographic cursor for `?before=` pagination
--  - soft delete leaves a tombstone (deleted_at) — moderators and senders
--    "delete" messages, history shows "message removed"
--  - unread badges come from group_members.last_read_at (0006) vs created_at
CREATE TABLE group_messages (
  id         TEXT PRIMARY KEY,   -- ULID: sortable, cursor-paginated
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_group_messages ON group_messages(group_id, id);
