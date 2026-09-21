-- 0006: social layer, phase 2 — groups + membership + invites.
--  - groups: owned by the creating user; the owner row in group_members is
--    authoritative for role (owner_id is a convenience for UI checks)
--  - group_members: role ('owner'|'admin'|'member') + per-member capability
--    flags (`perms`, JSON array of shared/constants GROUP_PERMS — the owner
--    implicitly holds all of them). last_read_at powers the phase-3 chat
--    unread badge.
--  - group_invites: per-user (username-addressed) invitations
--  - group_invite_links: token-capability links; only the SHA-256 hash is
--    stored (same posture as auth_sessions), expiry + use caps + revocation
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4f8cff',
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  perms        TEXT NOT NULL DEFAULT '',  -- JSON array of GROUP_PERMS; '' = none
  last_read_at INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

CREATE TABLE group_invites (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','declined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, invitee_id)
);
CREATE INDEX idx_group_invites_invitee ON group_invites(invitee_id);

CREATE TABLE group_invite_links (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER,                 -- NULL = never expires
  max_uses   INTEGER,                 -- NULL = unlimited
  use_count  INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_group_links_group ON group_invite_links(group_id);
