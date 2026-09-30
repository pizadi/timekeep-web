# Admin guide

Operating a TimeKeep Web instance as the admin. Setup/deployment is in
[deployment.md](deployment.md); this page is day-to-day operation.

## Signing in

- Username `admin`. There is **no default password**: migration 0012 removed
  the once-shipped credential (it was public in the repo — audit F5). The
  first credential is set on the server with `npm run admin:create`
  (`--remote` for a deployed instance; see
  [deployment.md](deployment.md#4-deploy)), which prints a generated
  passphrase once.
- If the password is ever lost, see
  [Admin account recovery](deployment.md#admin-account-recovery). The admin
  account can never be deactivated or self-deleted.

## Managing users

Everything lives in **Settings → Admin — users**. Accounts are admin-managed:
there is no self-signup anywhere in the product.

| Action                         | What happens                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create user**                | you set a username + temporary password; the user must change it at first login (`must_change_password` gate blocks everything except reading `/me`, changing the password, and signing out)                                                                                                                                                                                 |
| **Reset password**             | generates a new temporary password and **revokes all the user's sessions**                                                                                                                                                                                                                                                                                                   |
| **Deactivate** ("remove user") | `active=0` + all sessions revoked; sign-in is blocked with `account_disabled`; **user data is never deleted** — reactivate to restore access                                                                                                                                                                                                                                 |
| **Delete account**             | only the user can do this themselves (Settings → danger zone): a hard cascade delete plus a deletion log entry. Shared group rows they created are reassigned to each group's (new) owner, and a group they owned passes to the earliest-joined remaining member; their own data — including their DO-side pomodoro state — is destroyed. The admin panel never deletes data |

Usernames are the login identifier. Email is optional — it's only a target
for verification/reset mail (without a `RESEND_API_KEY` no mail is sent; the
admin resets passwords from the panel instead).

## Groups & permissions

Groups are created by any user; the **creator is the owner** and is the only
one who grants/revokes member permissions. Per-member flags:

- `edit_group` — rename the group, manage membership (except roles)
- `edit_tasks` — edit tasks in the group's shared projects, create group
  projects
- `invite` — invite members (username invites + join links)

The owner implicitly holds every permission. Group projects are visible to
all members; **sessions and reports stay strictly user-owned** — members see
attribution, never each other's raw sessions or notes.

Friend-sharing and group-sharing never cross: a project shared to a friend
(`visibility='friends'`) cannot be a group project, and vice versa.

## Backups & data safety

- **Daily R2 dump** — at 03:17 UTC every persistent table (projects, tasks,
  sessions, goals, groups, chat, …) is dumped to the R2 bucket as NDJSON, kept
  30 days. Credential columns (`password_hash`, invite-link token hashes) are
  never written. Requires the optional R2 bucket from [deployment.md](deployment.md);
  without it the instance has only D1 Time Travel, and the cron logs a
  `SECURITY_backup_not_configured` warning every run. Restore instructions:
  [deployment.md — Restore runbook](deployment.md#restore-runbook-rehearse-before-you-need-it).
- **User-facing export** — every user can export their own data as JSON or
  CSV at any time; JSON import supports merge-by-id and duplicate modes.
- Rate counters, sessions and email tokens are pruned automatically on the
  same cron.

## Upgrading the instance

See [deployment.md — Upgrades](deployment.md#upgrades): pull, build, migrate
remote, deploy, confirm via `/api/version`. Migrations are additive by
policy, so upgrades are rollback-safe.
