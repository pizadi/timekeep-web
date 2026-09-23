# Admin guide

Operating a TimeKeep Web instance as the admin. Setup/deployment is in
[deployment.md](deployment.md); this page is day-to-day operation.

## Signing in

- Username `admin`, initial password `changemeasap` — you're forced to set a
  real password at first login. **Rotate it immediately on any real
  deployment** (the default is public in the repo).
- If the password is ever lost, see
  [Admin account recovery](deployment.md#admin-account-recovery). The admin
  account can never be deactivated or self-deleted.

## Managing users

Everything lives in **Settings → Admin — users**. Accounts are admin-managed:
there is no self-signup anywhere in the product.

| Action | What happens |
|---|---|
| **Create user** | you set a username + temporary password; the user must change it at first login (`must_change_password` gate blocks everything except reading `/me`, changing the password, and signing out) |
| **Reset password** | generates a new temporary password and **revokes all the user's sessions** |
| **Deactivate** ("remove user") | `active=0` + all sessions revoked; sign-in is blocked with `account_disabled`; **user data is never deleted** — reactivate to restore access |
| **Delete account** | only the user can do this themselves (Settings → danger zone): a hard cascade delete plus a deletion log entry. The admin panel never deletes data |

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

- **Daily R2 dump** — at 03:17 UTC all tables are dumped to the R2 bucket as
  NDJSON, kept 30 days. Requires the optional R2 bucket from
  [deployment.md](deployment.md).
- **User-facing export** — every user can export their own data as JSON or
  CSV at any time; JSON import supports merge-by-id and duplicate modes.
- Rate counters, sessions and email tokens are pruned automatically on the
  same cron.

## Upgrading the instance

See [deployment.md — Upgrades](deployment.md#upgrades): pull, build, migrate
remote, deploy, confirm via `/api/version`. Migrations are additive by
policy, so upgrades are rollback-safe.
