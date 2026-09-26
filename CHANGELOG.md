# 0.5.3

Fifteen dev iterations closing the repository audit plus six fixes from the
"add later" list. The headline items: every mutating route is now
rate-limited, capacity caps are enforced atomically, and the repo has ESLint
and Prettier in CI.

## Security & correctness (audit)

- **Write rate limiting** — the CRUD/task/session/timer/group routes had _no_
  rate limit, only eventual entity-count caps, so a leaked session could
  hammer `/timer/start` + `/timer/stop` freely. New `write_user` bucket
  (`RL_WRITE_USER`, 300/min) with `limitWrites` middleware on every mutating
  route; reads are skipped and a per-request flag keeps one write counted once
  where two route files match the same path. `e2e/write-limit-test.mjs` covers
  it against a dedicated throwaway instance.
- **Atomic capacity caps** — group creation, join-by-link, invite accept,
  invite-link minting, friend requests and friend-request accept enforced their
  caps with `SELECT COUNT(*)` in a _separate_ statement from the insert, so
  concurrent requests could overshoot. Each cap now lives inside the
  INSERT/UPDATE with a `meta.changes` check; friend accept writes both
  friendship rows from one compound statement so the pair is all-or-nothing.
- **Reset-request timing** — the response body was identical whether or not an
  account existed, but the paths took very different time (an unknown email
  skipped the token insert _and_ the outbound email fetch). The send moved onto
  `waitUntil` and every skip branch now burns equivalent work.
- **Seeded admin credential** — the daily cron verifies the published default
  password against the admin hash and logs `SECURITY_admin_default_password`
  while it still works. The deploy workflow warns (non-blocking) when Turnstile
  is unconfigured, since bot defense silently no-ops without the secret.
- **CSP containment** — `style-src-elem 'self'` refuses an injected `<style>`
  block while React's inline style attributes keep working.
  `test/csp.test.ts` locks the "no `innerHTML` / `dangerouslySetInnerHTML` in
  the SPA" invariant, so a future HTML-rendering feature trips a test instead
  of silently losing CSP.
- **Release-tag guard** — the deploy workflow's `v*` glob would also have
  matched a `vX.Y.Z.devN` tag; the filter now excludes dev versions and
  `scripts/check-release-tag.mjs` fails a tagged run whose package.json isn't a
  clean `x.y.z` matching the tag.

## Bugs found by the new tooling

- **Conditional hook in Settings** — `useModalA11y` was called after an
  `if (!settings) return null`, so React would have thrown "rendered fewer
  hooks than expected" had the settings row ever arrived a render late.
- **A round-trip assertion that never asserted** — `roundtrip-test.mjs`
  computed the imported session count and printed it, but left it out of the
  verdict.
- **Chart cleanup used a stale ref** — the dashboard destroyed whatever
  `charts.current` held at teardown instead of the instances its own effect
  created.
- **`fromLocalInput` diverged inside a DST gap** — a wall clock that doesn't
  exist (spring forward) drifted ~4h per iteration and saved the session hours
  away from what was typed. It now case-analyses the two offsets and falls
  forward (`02:30` → `03:30`).
- Plus a dead `PRESETS` const surviving only as a type, four bare
  `eslint-disable` comments that suppressed nothing, and vestigial bindings in
  three e2e scripts.

## Timezone

- **The profile timezone is seeded from the device** on first login, while it
  still holds the `'UTC'` default that admin-created users start with — a zone
  picked in Settings is never overwritten. This was the real cause of manual
  session entry feeling "off": the whole app bucketed and displayed wall clocks
  in UTC.
- **Manual session editor** labels both date fields with the zone, shows the
  zone's UTC offset and the resulting duration, and warns about DST edge cases
  (a time that doesn't exist, or one that happens twice).

## Resume

- **Resume restores the subtask**, not just the task. `/api/bootstrap` now
  returns `recent: [{ task_id, subtask_id }]` (one entry per task, carrying the
  subtask of that task's newest session), and the Resume button, the `R`
  shortcut and the "Jump back in" chips all start where you actually left off —
  falling back to the whole task if that subtask is gone.

## UI

- Running-time badges read **"N running"** instead of "+N minutes running" in
  both the Daily summary and the per-task table (the printed value already
  includes running time; the `+` read as an addition).
- **Multi-line chat messages render with their line breaks** — the composer's
  Shift+Enter newlines were stored correctly all along but collapsed visually.
- **The sidebar ✕ is hidden on wide screens.** `.icon-btn`'s
  `display: inline-flex` sits later in the stylesheet with equal specificity
  and was overriding the hide rule, so the button appeared at ≥1024px where
  closing the sidebar does nothing.

## Tooling

- **ESLint 9** (flat config, typescript-eslint + react-hooks) and **Prettier 3**,
  both blocking in CI's `verify` job. `noUnusedLocals`/`noUnusedParameters` on
  both tsconfig projects make the existing typecheck a dead-code gate.
- `no-explicit-any` is off by design (the store/API layer is `any`-typed at its
  edges) and `react-hooks/exhaustive-deps` is a warning, with each intentional
  narrowing carrying a named disable and a reason.
- The repository was reformatted once, in a single mechanical commit.

## Docs

- Deployment notes state that the **Workers free plan is sufficient**; the
  previous "Workers Paid required" claim (and its reasoning about PBKDF2 CPU
  cost) was wrong.
- `oauth_accounts` and `users.totp_secret` are documented as reserved,
  unused placeholders for the unimplemented FR-A3/FR-A9.
- Scratch files and throwaway `wrangler dev` state belong in the gitignored
  `.work/` directory, not `/tmp`.
