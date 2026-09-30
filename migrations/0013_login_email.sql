-- F15 (audit): `users.email` doubled as the login identifier for users without
-- a mailbox (their '@'-free username stored there — usernames cannot contain
-- '@', real addresses always do, so the two shapes never collide). Every mail
-- path had to re-derive "is this a real address" with includes('@'); a new
-- code path could forget. `login_email` is the authoritative marker: set iff
-- the user has a real mailbox. The legacy `email` mirror is KEPT — the column
-- is UNIQUE (username mirror + real addresses share the constraint), the
-- export/user payloads expose it, and login's identifier lookup reads it.
-- New writes go dual-column (see routes/admin.ts create); a later release can
-- drop the mirror once nothing depends on it.
ALTER TABLE users ADD COLUMN login_email TEXT;

-- backfill: real addresses only — the username-mirror rows (no '@') keep
-- login_email NULL, which is exactly the distinction the mail paths need
UPDATE users SET login_email = email WHERE email LIKE '%@%';
