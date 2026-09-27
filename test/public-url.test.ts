// INV-09: reset and verification links always use the canonical public origin.
//
// The links carry a bearer token — the emailed link IS the credential. While
// their origin came from `new URL(c.req.url).origin`, any Host header the
// deployment accepted could turn a legitimate password-reset email into
// `https://attacker.example/reset?token=…`, and a victim who clicked it would
// hand the token straight over.
//
// Whether the OLD behavior was exploitable depended on Cloudflare's/custom
// domain routing accepting a spoofed Host; the fix removes the dependency
// entirely, so the property is now unconditional.
import { describe, it, expect } from 'vitest';
import { publicOrigin, secretLink } from '../src/shared/public-url';

const CANONICAL = 'https://timekeep.example.com';
const env = { APP_PUBLIC_URL: CANONICAL };

/** Host headers/URLs an attacker might get the deployment to accept. */
const HOSTILE = [
  'https://attacker.example/api/auth/reset-request',
  'http://localhost:8787/api/auth/reset-request',
  'https://timekeep.example.com.attacker.example/api/auth/reset-request',
  'https://TIMEKEEP.EXAMPLE.COM/api/auth/reset-request',
  'http://127.0.0.1:8787/api/auth/reset-request',
  'https://[::1]:8787/api/auth/reset-request',
  'https://xn--timekeep-8ya.example/api/auth/reset-request',
];

describe('publicOrigin (INV-09)', () => {
  it('the configured origin wins for every request URL, including hostile ones', () => {
    for (const url of HOSTILE) {
      expect(publicOrigin(env, url)).toBe(CANONICAL);
    }
  });

  it('is case-insensitive about the configured host (URL parsing normalizes it)', () => {
    expect(publicOrigin({ APP_PUBLIC_URL: 'https://TimeKeep.Example.com' }, HOSTILE[0]!)).toBe(CANONICAL);
  });

  it('ignores a path, query or trailing slash on the configured value', () => {
    for (const configured of [
      'https://timekeep.example.com/',
      'https://timekeep.example.com//',
      'https://timekeep.example.com/app',
      'https://timekeep.example.com/app?x=1#f',
      '  https://timekeep.example.com  ',
    ]) {
      expect(publicOrigin({ APP_PUBLIC_URL: configured }, HOSTILE[0]!)).toBe(CANONICAL);
    }
  });

  it('falls back to the request origin when unconfigured (local dev needs no setup)', () => {
    expect(publicOrigin({}, 'http://localhost:8787/api/auth/reset-request')).toBe('http://localhost:8787');
    expect(publicOrigin({ APP_PUBLIC_URL: '' }, 'http://localhost:8787/x')).toBe('http://localhost:8787');
    expect(publicOrigin({ APP_PUBLIC_URL: '   ' }, 'http://localhost:8787/x')).toBe('http://localhost:8787');
  });

  it('a malformed configured value falls back rather than emitting a broken link', () => {
    // Better a request-derived link (locally fine) than
    // `timekeep.example.com/reset?token=…` with no origin at all.
    expect(publicOrigin({ APP_PUBLIC_URL: 'not a url' }, 'http://localhost:8787/x')).toBe('http://localhost:8787');
    expect(publicOrigin({ APP_PUBLIC_URL: 'javascript:alert(1)' }, 'http://localhost:8787/x')).toBe(
      'http://localhost:8787',
    );
  });
});

describe('secretLink (INV-09)', () => {
  it('builds a reset link on the canonical origin, token-encoded', () => {
    expect(secretLink(env, HOSTILE[0]!, '/reset', 'a+b/c=')).toBe(`${CANONICAL}/reset?token=a%2Bb%2Fc%3D`);
  });

  it('builds a verification link on the canonical origin', () => {
    expect(secretLink(env, HOSTILE[2]!, '/verify', 'tok')).toBe(`${CANONICAL}/verify?token=tok`);
  });

  it('no hostile request URL can move the token off the canonical origin', () => {
    for (const url of HOSTILE) {
      const link = secretLink(env, url, '/reset', 'super-secret');
      expect(link.startsWith(`${CANONICAL}/reset?`)).toBe(true);
      expect(link).toContain('token=super-secret');
    }
  });
});
