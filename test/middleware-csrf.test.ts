// CSRF double-submit without an Origin header (audit F11) + XFF trust gate
// (audit F12).
//
// F11: the double-submit check used to run only `if (origin)` — a request that
// simply OMITTED the Origin header (old browser, non-browser client that
// logged in and received the CSRF cookie) passed on SameSite=Lax +
// Sec-Fetch-Site alone. The cookie/header comparison must run whenever the
// CSRF cookie is present on an unsafe method, Origin or not.
//
// F12: `clientIp` fell back to the first X-Forwarded-For value whenever
// `cf-connecting-ip` was absent. If that path were ever reachable in
// production, an attacker could rotate the header for a fresh rate-limit
// bucket per request. XFF is now honoured only under the dev-only
// `DEV_TRUST_XFF=1` flag; otherwise the subject falls back to 'unknown'.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { clientIp, csrfGuard } from '../src/worker/middleware';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/shared/constants';

/** POST target behind the guard, wired exactly like the route files do. */
function app() {
  const root = new Hono();
  root.use('/api/*', csrfGuard);
  root.post('/api/thing', (c) => c.json({ ok: true }));
  root.get('/api/thing', (c) => c.json({ ok: true }));
  return root;
}

const req = (opts: { method?: string; origin?: string; cookie?: string; csrfHeader?: string; fetchSite?: string }) => {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrfHeader) headers[CSRF_HEADER] = opts.csrfHeader;
  if (opts.fetchSite) headers['sec-fetch-site'] = opts.fetchSite;
  return new Request('http://x/api/thing', { method: opts.method ?? 'POST', headers });
};

describe('csrfGuard (F11: double-submit no longer Origin-gated)', () => {
  it('safe methods skip the guard entirely', async () => {
    const res = await app().fetch(req({ method: 'GET', cookie: `${CSRF_COOKIE}=t` }), {});
    expect(res.status).toBe(200);
  });

  it('cross-site fetch-site is blocked regardless of everything else', async () => {
    const res = await app().fetch(req({ fetchSite: 'cross-site', origin: 'http://x' }), {});
    expect(res.status).toBe(403);
  });

  it('off-allowlist Origin is blocked', async () => {
    const res = await app().fetch(req({ origin: 'http://evil' }), {});
    expect(res.status).toBe(403);
  });

  it('Origin present + cookie without header → 403 (already enforced before F11)', async () => {
    const res = await app().fetch(req({ origin: 'http://x', cookie: `${CSRF_COOKIE}=t` }), {});
    expect(res.status).toBe(403);
  });

  it('NO Origin + cookie without header → 403 (the F11 hole: was 200)', async () => {
    const res = await app().fetch(req({ cookie: `${CSRF_COOKIE}=t` }), {});
    expect(res.status).toBe(403);
  });

  it('NO Origin + cookie with mismatching header → 403 (the F11 hole: was 200)', async () => {
    const res = await app().fetch(req({ cookie: `${CSRF_COOKIE}=t`, csrfHeader: 'other' }), {});
    expect(res.status).toBe(403);
  });

  it('NO Origin + cookie with matching header → 200', async () => {
    const res = await app().fetch(req({ cookie: `${CSRF_COOKIE}=t`, csrfHeader: 't' }), {});
    expect(res.status).toBe(200);
  });

  it('NO Origin + no cookie + no header → 200 (non-browser client before first GET)', async () => {
    const res = await app().fetch(req({}), {});
    expect(res.status).toBe(200);
  });

  it('matching Origin + matching double-submit pair → 200 (browser path unchanged)', async () => {
    const res = await app().fetch(req({ origin: 'http://x', cookie: `${CSRF_COOKIE}=t`, csrfHeader: 't' }), {});
    expect(res.status).toBe(200);
  });
});

const ipCtx = (headers: Record<string, string>) =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] } }) as any;

describe('clientIp (F12: XFF only under DEV_TRUST_XFF)', () => {
  it('cf-connecting-ip wins regardless of the flag', () => {
    expect(clientIp(ipCtx({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), {})).toBe('1.1.1.1');
    expect(
      clientIp(ipCtx({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), { DEV_TRUST_XFF: '1' }),
    ).toBe('1.1.1.1');
  });

  it('ignores XFF when DEV_TRUST_XFF is unset (the F12 hole: returned the header)', () => {
    expect(clientIp(ipCtx({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), {})).toBeNull();
    expect(clientIp(ipCtx({ 'x-forwarded-for': '2.2.2.2' }), { DEV_TRUST_XFF: undefined })).toBeNull();
  });

  it('uses the first XFF value when DEV_TRUST_XFF=1 (dev only)', () => {
    expect(clientIp(ipCtx({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), { DEV_TRUST_XFF: '1' } as any)).toBe('2.2.2.2');
  });

  it('no headers at all → null (callers fall back to unknown)', () => {
    expect(clientIp(ipCtx({}), {})).toBeNull();
    expect(clientIp(ipCtx({}), { DEV_TRUST_XFF: '1' } as any)).toBeNull();
  });
});
