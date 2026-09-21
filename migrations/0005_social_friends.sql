-- 0005: social layer, phase 1 — friends + project visibility.
--  - friend_requests: pending invitations keyed by username (no self-signup —
--    both sides are admin-created accounts)
--  - friendships: TWO rows per friendship (a→b and b→a) so every read stays a
--    plain `WHERE user_id = ?` scoped query, matching the codebase's NFR-3
--    ownership-check posture
--  - projects.visibility: 'private' (default) | 'friends'. Additive ADD COLUMN
--    only — table rebuilds are unsafe in D1 (see 0003).
CREATE TABLE friend_requests (
  id           TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (from_user_id, to_user_id)
);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user_id);

CREATE TABLE friendships (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX idx_friendships_friend ON friendships(friend_id);

ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private','friends'));
