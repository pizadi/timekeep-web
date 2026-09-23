# Documentation index

TimeKeep Web — a browser-based time-tracking and task-management app for
Cloudflare Workers + D1 + Durable Objects, with admin-managed accounts and
multi-device live sync.

| Doc | Audience | Contents |
|---|---|---|
| [development.md](development.md) | developers | local setup, dev servers, migrations, versioning & release process |
| [architecture.md](architecture.md) | developers | how the system works, in depth |
| [testing.md](testing.md) | developers | unit tests + the e2e suite (incl. CI) |
| [deployment.md](deployment.md) | operators | Cloudflare setup, config & secrets, upgrades, rollback |
| [admin-guide.md](admin-guide.md) | operators | running an instance: users, groups, backups |
| [requirement-coverage.md](requirement-coverage.md) | reference | spec coverage & known trade-offs |

Quick paths:

- **Run it locally** → [development.md](development.md)
- **Deploy your own instance** → [deployment.md](deployment.md)
- **You admin one and forgot the password** → [deployment.md — admin recovery](deployment.md#admin-account-recovery)
- **Wondering why the timer can't race** → [architecture.md](architecture.md)
