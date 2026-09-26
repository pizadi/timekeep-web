// requireAuth must authorize a request EXACTLY ONCE, even though every route
// file registers both a bare path and its wildcard (`use('/me', …)` +
// `use('/me/*', …)`) and Hono matches a bare path against both.
//
// Without the `if (c.get('user')) return next()` guard in requireAuth, the
// second run re-reads the session from the *request* cookie — which a token
// rotation has already replaced — and answers 401 to a request the first run
// had authorized. In the app that means: any user whose session is inside the
// 7-day rotation window gets signed out by their next request to a bare path
// (/me, /sessions, /projects, /groups, …), and every bare-path request paid for
// two session lookups.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireAuth } from '../src/worker/middleware';
import { sha256Hex } from '../src/worker/auth';
import { SESSION_COOKIE } from '../src/shared/constants';
import { fakeD1, expiringSession, fakeUser } from './support/fake-d1';

const NOW = Date.now();

/** The /me surface exactly as src/worker/routes/me.ts wires it. */
function app() {
  const me = new Hono();
  me.use('/me', requireAuth);
  me.use('/me/*', requireAuth);
  me.get('/me', (c) => c.json({ user: c.get('user').id }));
  me.get('/me/sessions', (c) => c.json({ ok: true }));
  const root = new Hono();
  root.route('/api', me);
  return root;
}

function envFor(db: ReturnType<typeof fakeD1>) {
  return { DB: db.db, USER_HUB: undefined } as any;
}
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as any;

async function fixture(inDays: number) {
  const token = 'b'.repeat(64);
  const hash = await sha256Hex(token);
  const db = fakeD1([expiringSession('sess-1', 'user-1', hash, NOW, inDays)], [fakeUser('user-1')]);
  return { token, db };
}

const get = (token: string) =>
  new Request('http://x/api/me', { headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-device-id': 'test' } });

describe('requireAuth runs once per request', () => {
  it('authorizes a bare path once and returns 200 (the wildcard match does not re-auth)', async () => {
    const { token, db } = await fixture(20);
    const res = await app().fetch(get(token), envFor(db), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'user-1' });
    // one session lookup, not two
    expect(db.log.filter((s) => s.includes('FROM auth_sessions s WHERE s.token_hash'))).toHaveLength(1);
  });

  it('rotates exactly once for a session inside the window — one new cookie, still 200', async () => {
    const { token, db } = await fixture(3);
    const res = await app().fetch(get(token), envFor(db), ctx());
    expect(res.status).toBe(200);
    const sessionCookies = (res.headers.getSetCookie?.() ?? []).filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookies).toHaveLength(1);
    // in place: same row, new hash — no second session
    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0].id).toBe('sess-1');
    expect(db.rows()[0].token_hash).not.toBe(await sha256Hex(token));
  });

  it('the rotated cookie authenticates on the next request', async () => {
    const { token, db } = await fixture(3);
    const first = await app().fetch(get(token), envFor(db), ctx());
    const rotated = (first.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!
      .split('=')[1]!;
    const second = await app().fetch(get(rotated), envFor(db), ctx());
    expect(second.status).toBe(200);
  });

  it('a revoked session 401s and cannot be resurrected by the rotation', async () => {
    const { token, db } = await fixture(3);
    // the concurrent revocation deletes the row before the CAS is applied
    db.beforeApply = (sql) => {
      if (sql.startsWith('UPDATE auth_sessions SET token_hash')) db.sessions.delete('sess-1');
    };
    const res = await app().fetch(get(token), envFor(db), ctx());
    expect(res.status).toBe(401);
    expect(db.rows()).toHaveLength(0);
  });

  it('wildcard paths are unaffected', async () => {
    const { token, db } = await fixture(3);
    const res = await app().fetch(
      new Request('http://x/api/me/sessions', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      envFor(db),
      ctx(),
    );
    expect(res.status).toBe(200);
  });
});
