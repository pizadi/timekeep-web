// The login route must not let an unauthenticated attacker spend another
// user's lockout budget.
//
// The order used to be: charge the per-IP AND per-identifier counters, then
// verify Turnstile. Turnstile is the app's only distributed bot defense (the
// per-identifier counter is a plain DB counter, so a botnet shares it), so
// charging the identifier budget before the challenge handed any anonymous
// caller a 10-attempts-per-15-minutes lockout against any username they could
// guess — exactly the denial of service the challenge exists to prevent.
//
// Pinned here with the challenge ACTIVE (a dummy secret + a stubbed siteverify)
// because in dev Turnstile is disabled and the ordering is unobservable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../src/worker/routes/auth';
import { hashPassword } from '../src/worker/auth';
import { fakeD1, fakeUser, type FakeD1 } from './support/fake-d1';

// 2 attempts per identifier so the budget is visible after a couple of calls
const RL_LOGIN_EMAIL = '2';
const RL_LOGIN_IP = '1000';

function app() {
  const root = new Hono();
  root.route('/api', authRoutes);
  return root;
}

function envFor(db: FakeD1) {
  return {
    DB: db.db,
    TURNSTILE_SECRET_KEY: 'test-secret', // challenge ACTIVE
    TURNSTILE_SITE_KEY: 'test-site',
    PBKDF2_ITERATIONS: '1000',
    RL_LOGIN_EMAIL,
    RL_LOGIN_IP,
  } as any;
}
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as any;

const login = (identifier: string, password: string, turnstile?: string) =>
  new Request('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ identifier, password, ...(turnstile ? { turnstile } : {}) }),
  });

async function post(db: FakeD1, req: Request) {
  return app().fetch(req, envFor(db), ctx());
}

/** The live counter for an identifier bucket, if it was ever charged. */
const identifierHits = (db: FakeD1, identifier: string) => {
  const key = `login_email:${identifier.toLowerCase()}:`;
  for (const [k, v] of db.counters) if (k.startsWith(key)) return v;
  return 0;
};

describe('login lockout ordering (Turnstile first)', () => {
  beforeEach(() => {
    // siteverify stands in for Cloudflare: `valid` decides its answer
    (globalThis as any).__turnstileValid = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: (globalThis as any).__turnstileValid })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a failed challenge does not consume the identifier budget', async () => {
    (globalThis as any).__turnstileValid = false;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    // three attempts, all refused by the challenge — more than the budget
    for (let i = 0; i < 3; i++) {
      const res = await post(db, login('dana', 'correct-horse-123', 'bogus-token'));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe('turnstile');
    }
    expect(identifierHits(db, 'dana')).toBe(0);

    // …and the victim can still sign in, twice over the 2-attempt budget
    (globalThis as any).__turnstileValid = true;
    for (let i = 0; i < 2; i++) {
      const res = await post(db, login('dana', 'correct-horse-123', 'good-token'));
      expect(res.status).toBe(200);
    }
    expect(identifierHits(db, 'dana')).toBe(2);
  });

  it('a solved challenge with a wrong password DOES consume the budget', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    for (let i = 0; i < 2; i++) {
      const res = await post(db, login('dana', 'wrong-password-99', 'good-token'));
      expect(res.status).toBe(401);
    }
    expect(identifierHits(db, 'dana')).toBe(2);
    // the third attempt is over budget — the counter still protects the account
    const over = await post(db, login('dana', 'correct-horse-123', 'good-token'));
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe('rate_limited');
  });

  it('the coarse per-IP limit still runs before the challenge', async () => {
    (globalThis as any).__turnstileValid = false;
    const db = fakeD1([], []);
    const env = { ...envFor(db), RL_LOGIN_IP: '1' };
    const first = await app().fetch(login('someone', 'nope-nope-1234', 'bogus'), env, ctx());
    expect(first.status).toBe(422); // challenge refused it
    const second = await app().fetch(login('someone', 'nope-nope-1234', 'bogus'), env, ctx());
    expect(second.status).toBe(429); // …and the IP budget sheds the flood
  });

  it('an unknown identifier is charged the same as a known one (no enumeration oracle)', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const res = await post(db, login('ghost', 'whatever-password', 'good-token'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_credentials');
    expect(identifierHits(db, 'ghost')).toBe(1);
  });
});
