-- 0012 (audit F5): stop shipping a working credential.
--
-- Migration 0002 seeded the admin with a precomputed hash of 'changemeasap' —
-- a password printed in the README, i.e. public knowledge. Between the first
-- deploy and a manual rotation, anyone who found the URL could sign in as
-- admin (the forced password change did not help: the attacker changes the
-- password themselves and owns the instance).
--
-- The fix removes the credential instead of rotating it: the hash is nulled
-- ONLY where it is still the seeded literal, so an admin who already rotated
-- (the only safe state this migration can find) keeps their hash untouched.
-- A NULL password_hash can never log in — the login route treats it exactly
-- like an unknown account (generic 401, same burn-time) — and
-- `npm run admin:create` sets the first usable credential (prints a generated
-- passphrase once; never accepts one on argv).
--
-- Additive, no table rebuild (D1 gotcha). The daily cron reports a NULL-hash
-- admin as SECURITY_admin_unusable until the bootstrap runs.

UPDATE users
SET password_hash = NULL
WHERE username = 'admin'
  AND role = 'admin'
  AND password_hash = 'pbkdf2$600000$cea27753dabc3263979783f4085bcf71$ba577c389e398fd2882f0fee977eaff6e6372093b1c00093f541c2cfd9f2ce71';
