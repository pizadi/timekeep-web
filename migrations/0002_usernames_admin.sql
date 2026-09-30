-- 0002: admin-managed accounts (no self-signup).
--  - username column = login identifier; email stays for optional reset mail
--  - role ('user' | 'admin'), active (deactivation flag), must_change_password
--  - seeds the initial admin: username 'admin', password 'changemeasap',
--    forced to change it at first login (must_change_password = 1)
--    (NOTE: 0012 later nulls this seeded hash — audit F5 stopped shipping a
--    working credential; `npm run admin:create` sets the first real one)
--
-- The backfill is additive (no table rebuild) so FK children are untouched.
-- Note for dev databases with messy test data: users whose email has no local
-- part or colliding local-parts get deterministic unique usernames below. If
-- this migration still fails on a disposable dev DB, wipe .wrangler/ state and
-- re-run `npm run db:migrate:local`.

ALTER TABLE users ADD COLUMN username TEXT;

-- derive username from the email local-part ('a@x.com' -> 'a'); the || '@'
-- trick makes instr always match, so the result is never NULL
UPDATE users SET username = lower(substr(email, 1, instr(email || '@', '@') - 1))
WHERE username IS NULL;

-- fallback for rows that somehow have no usable local-part
UPDATE users SET username = lower(substr(id, 1, 12)) WHERE username IS NULL OR username = '';

-- De-duplicate colliding local-parts (only reachable on a database that
-- predates username: two rows can share a local part — 'a@x.com' and
-- 'a@y.com' — even though 0001's UNIQUE COLLATE NOCASE on email forbids
-- duplicate emails).
--
-- Select the colliding USERNAMES and rename every row that has one. The
-- previous form — `WHERE id IN (SELECT id FROM users GROUP BY username HAVING
-- COUNT(*) > 1)` — selected one ARBITRARY id per group (a bare column in a
-- grouped subquery is not a per-group list), so it renamed one row and left
-- the rest: with two rows per group the survivor happened to be unique and the
-- migration passed by luck, and with three or more the unique index below
-- failed, aborting the migration mid-file against real data.
--
-- The suffix is the FULL id, not a prefix: two ids can share a leading
-- substring, and a truncated suffix reintroduces exactly the collision this
-- statement exists to remove. Usernames stay within the 32-char app limit
-- (26-char ULID + a few characters of base name).
UPDATE users SET username = username || '-' || id
WHERE username IN (SELECT username FROM users GROUP BY username HAVING COUNT(*) > 1);

CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- seed the initial admin (idempotent; fixed id + precomputed chained-PBKDF2
-- hash of 'changemeasap' — verifyPassword is format-driven, not env-driven)
INSERT INTO users (id, email, username, password_hash, name, timezone, week_start, theme,
                   role, active, must_change_password, email_verified_at, created_at, updated_at)
SELECT '01M2KR6R00895PBREEM1ET1JHT', 'admin', 'admin',
       'pbkdf2$600000$cea27753dabc3263979783f4085bcf71$ba577c389e398fd2882f0fee977eaff6e6372093b1c00093f541c2cfd9f2ce71',
       'Admin', 'UTC', 1, 'system', 'admin', 1, 1,
       1789516800000, 1789516800000, 1789516800000
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE username = 'admin' COLLATE NOCASE OR email = 'admin' COLLATE NOCASE
);
