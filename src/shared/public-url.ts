// Isomorphic (worker + SPA): the canonical public origin for links that carry
// a secret. Kept in src/shared/ so a unit test can cover it without the Worker
// runtime (src/shared is in BOTH tsconfig projects — AGENTS.md).

/**
 * The origin to build password-reset and email-verification links from.
 *
 * This MUST be deployment configuration, never request data. Deriving it from
 * `new URL(c.req.url).origin` means a Host header the deployment accepts can
 * put the victim's reset token on a host the attacker controls — and the token
 * is a bearer credential: clicking the emailed link hands over the account
 * (INV-09).
 *
 * With `APP_PUBLIC_URL` set, the configured origin always wins. Without it we
 * fall back to the request origin so local dev needs no configuration; that
 * fallback is the deployment mistake the deploy workflow warns about, and it
 * is safe only because the production host is not attacker-influenced there.
 */
export function publicOrigin(env: { APP_PUBLIC_URL?: string | null }, requestUrl: string): string {
  const configured = (env.APP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) {
    // A misconfigured value (bare host, path-only) must not silently produce a
    // broken link — fall back rather than emit `example.com/reset?token=`.
    try {
      const parsed = new URL(configured);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return new URL(requestUrl).origin;
      return parsed.origin;
    } catch {
      return new URL(requestUrl).origin;
    }
  }
  return new URL(requestUrl).origin;
}

/** A reset/verification link with its token, built from the canonical origin. */
export function secretLink(env: { APP_PUBLIC_URL?: string | null }, requestUrl: string, path: string, token: string) {
  return `${publicOrigin(env, requestUrl)}${path}?token=${encodeURIComponent(token)}`;
}
