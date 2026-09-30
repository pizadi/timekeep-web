// The login route must not let an unauthenticated attacker spend another
// user's lockout budget.
//
// Two related problems are pinned here:
//
// 1. ORDERING. The order used to be: charge the per-IP AND per-identifier
//    counters, then verify Turnstile. Turnstile is the app's only distributed
//    bot defense (the identifier counters are plain DB counters, so a botnet
//    shares them), so charging the identifier budgets before the challenge
//    handed any anonymous caller a lockout against any username they could
//    guess — exactly the denial of service the challenge exists to prevent.
//
// 2. KEYING (audit F6). The per-identifier counter used to be ONE
//    identifier-wide budget: ten failed logins for `dana` locked `dana` out
//    for 15 minutes no matter who sent them — anyone who knew a username
//    (they're not secrets) could keep a victim — or the admin — permanently
//    locked out by looping from any IP. Two counters now:
//      `login_user_ip`   — one source against one identifier (10/15min)
//      `login_identity`  — an identifier-wide ceiling (40/15min), bounding a
//                          distributed attack's volume on the account
//    so a single attacker exhausts only their own pair and the victim's own
//    network stays unaffected.
//
// Pinned with the challenge ACTIVE (a dummy secret + a stubbed siteverify)
// because in dev Turnstile is disabled and the ordering is unobservable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../src/worker/routes/auth';
import { hashPassword } from '../src/worker/auth';
import { fakeD1, fakeUser, type FakeD1 } from './support/fake-d1';

// 2 attempts per (identifier, ip) pair and 3 per identifier so the budgets are
// visible after a couple of calls
const RL_LOGIN_USER_IP = '2';
const RL_LOGIN_IDENTITY = '3';
const RL_LOGIN_IP = '1000';

function app() {
  const root = new Hono();
  root.route('/api', authRoutes);
  return root;
}

function envFor(db: FakeD1, over: Record<string, string> = {}) {
  return {
    DB: db.db,
    TURNSTILE_SECRET_KEY: 'test-secret', // challenge ACTIVE
    TURNSTILE_SITE_KEY: 'test-site',
    PBKDF2_ITERATIONS: '1000',
    RL_LOGIN_IP,
    RL_LOGIN_USER_IP,
    RL_LOGIN_IDENTITY,
    ...over,
  } as any;
}
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as any;

const loginFrom = (identifier: string, password: string, ip: string, turnstile?: string) =>
  new Request('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ identifier, password, ...(turnstile ? { turnstile } : {}) }),
  });
// default client for the older ordering tests
const login = (identifier: string, password: string, turnstile?: string) =>
  loginFrom(identifier, password, '203.0.113.9', turnstile);

async function post(db: FakeD1, req: Request, over: Record<string, string> = {}) {
  return app().fetch(req, envFor(db, over), ctx());
}

/** The live counter for an (identifier, ip) failure pair, if it was ever charged. */
const userIpHits = (db: FakeD1, identifier: string, ip: string) => {
  const key = `login_user_ip:${identifier}:${ip}:`;
  for (const [k, v] of db.counters) if (k.startsWith(key)) return v;
  return 0;
};

/** The live counter for the identifier-wide ceiling, if it was ever charged. */
const identityHits = (db: FakeD1, identifier: string) => {
  const key = `login_identity:${identifier}:`;
  for (const [k, v] of db.counters) if (k.startsWith(key)) return v;
  return 0;
};

// The reset endpoint is the other half of the same problem, and worse: an
// accepted request SENDS MAIL. The per-address budget (5/hour) bounds one
// mailbox; nothing bounded a single source asking for many distinct addresses
// (mail-provider quota, notification spam, service cost — the audit's #11).
// The budget is also ordered so a request that fails the bot challenge does not
// spend the victim's mailbox allowance.
describe('password-reset abuse budgets', () => {
  beforeEach(() => {
    (globalThis as any).__turnstileValid = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: (globalThis as any).__turnstileValid })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const envFor = (db: FakeD1, over: Record<string, string> = {}) =>
    ({
      DB: db.db,
      TURNSTILE_SECRET_KEY: 'test-secret',
      PBKDF2_ITERATIONS: '1000',
      RL_RESET_IP: '20',
      RL_RESET_EMAIL: '5',
      ...over,
    }) as any;

  const reset = (email: string, ip: string, turnstile?: string) =>
    new Request('http://x/api/auth/reset-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email, ...(turnstile ? { turnstile } : {}) }),
    });

  /** The live counter for a bucket, if it was ever charged. */
  const hits = (db: FakeD1, name: string, subject: string) => {
    const key = `${name}:${subject}:`;
    for (const [k, v] of db.counters) if (k.startsWith(key)) return v;
    return 0;
  };

  it('one source spraying many distinct addresses runs out of the per-IP budget', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const env = envFor(db, { RL_RESET_IP: '5' });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app().fetch(reset(`victim-${i}@example.com`, '203.0.113.7', 'good'), env, ctx());
      codes.push(res.status);
    }
    // 5 allowed, then 429 — the 6th distinct address from the SAME source is
    // refused, which is what bounds the fan-out.
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    // each address only spent one of its own budget
    expect(hits(db, 'reset_email', 'victim-7@example.com')).toBe(0);
    expect(hits(db, 'reset_ip', '203.0.113.7')).toBe(8);
  });

  it('a failed challenge spends neither the IP nor the mailbox budget', async () => {
    (globalThis as any).__turnstileValid = false;
    const db = fakeD1([], []);
    for (let i = 0; i < 4; i++) {
      const res = await app().fetch(reset('victim@example.com', '203.0.113.8', 'bogus'), envFor(db), ctx());
      expect(res.status).toBe(422);
    }
    expect(hits(db, 'reset_email', 'victim@example.com')).toBe(0);
    // the IP budget IS charged — a challenge failure must not be a free retry
    // loop for an anonymous flood, and 4 < 20 so the caller is not throttled.
    expect(hits(db, 'reset_ip', '203.0.113.8')).toBe(4);
  });

  it('one mailbox is still bounded on its own', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const env = envFor(db, { RL_RESET_IP: '1000', RL_RESET_EMAIL: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app().fetch(reset('one@example.com', `203.0.113.${i}`, 'good'), env, ctx());
      codes.push(res.status);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('a different source is unaffected by the first one running out', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const env = envFor(db, { RL_RESET_IP: '2' });
    for (let i = 0; i < 3; i++) await app().fetch(reset(`a${i}@example.com`, '203.0.113.9', 'good'), env, ctx());
    const other = await app().fetch(reset('a0@example.com', '198.51.100.4', 'good'), env, ctx());
    expect(other.status).toBe(200);
  });

  it('a malformed body is answered identically and spends no budget', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const res = await app().fetch(
      new Request('http://x/api/auth/reset-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({ nope: true }),
      }),
      envFor(db),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hits(db, 'reset_ip', '203.0.113.10')).toBe(0);
  });
});

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

  it('a failed challenge does not consume either identifier budget', async () => {
    (globalThis as any).__turnstileValid = false;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    // three attempts, all refused by the challenge — more than the pair budget
    for (let i = 0; i < 3; i++) {
      const res = await post(db, login('dana', 'correct-horse-123', 'bogus-token'));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe('turnstile');
    }
    expect(userIpHits(db, 'dana', '203.0.113.9')).toBe(0);
    expect(identityHits(db, 'dana')).toBe(0);

    // …and the victim can still sign in, twice over the 2-attempt pair budget
    (globalThis as any).__turnstileValid = true;
    for (let i = 0; i < 2; i++) {
      const res = await post(db, login('dana', 'correct-horse-123', 'good-token'));
      expect(res.status).toBe(200);
    }
    expect(userIpHits(db, 'dana', '203.0.113.9')).toBe(2);
  });

  it('a solved challenge with a wrong password DOES consume the budget', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    for (let i = 0; i < 2; i++) {
      const res = await post(db, login('dana', 'wrong-password-99', 'good-token'));
      expect(res.status).toBe(401);
    }
    expect(userIpHits(db, 'dana', '203.0.113.9')).toBe(2);
    // the third attempt from the same source is over budget — the counter
    // still protects the account
    const over = await post(db, login('dana', 'correct-horse-123', 'good-token'));
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe('rate_limited');
  });

  it('a DIFFERENT source is not locked out by one attacker exhausting its pair (F6)', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    // the attacker burns the (dana, attacker-ip) pair with wrong passwords
    for (let i = 0; i < 2; i++) {
      const res = await post(db, loginFrom('dana', 'wrong-password-99', '203.0.113.7', 'good-token'));
      expect(res.status).toBe(401);
    }
    // the attacker's own pair is spent …
    const attacker = await post(db, loginFrom('dana', 'correct-horse-123', '203.0.113.7', 'good-token'));
    expect(attacker.status).toBe(429);
    // … but the victim, signing in from their own (usual) network, is not:
    // the pair keying is the whole point (audit F6 — one attacker must not be
    // able to lock a known username out)
    const victim = await post(db, loginFrom('dana', 'correct-horse-123', '198.51.100.4', 'good-token'));
    expect(victim.status).toBe(200);
    expect(userIpHits(db, 'dana', '198.51.100.4')).toBe(1);
  });

  it('a distributed attack still hits the identifier-wide ceiling (F6)', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], [fakeUser('dana', { password_hash: await hashPassword('correct-horse-123', 1000) })]);
    // one wrong attempt per source: every (identifier, ip) pair stays within
    // its own budget, but the identifier-wide ceiling (3 here) bounds the
    // distributed volume against the account
    const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];
    for (const [i, ip] of ips.entries()) {
      const res = await post(db, loginFrom('dana', 'wrong-password-99', ip, 'good-token'));
      expect(res.status).toBe(i < 3 ? 401 : 429);
    }
    expect(identityHits(db, 'dana')).toBe(4); // refused attempts are charged too
    // and the ceiling binds the real password too, from yet another IP
    const victim = await post(db, loginFrom('dana', 'correct-horse-123', '198.51.100.4', 'good-token'));
    expect(victim.status).toBe(429);
  });

  it('the coarse per-IP limit still runs before the challenge', async () => {
    (globalThis as any).__turnstileValid = false;
    const db = fakeD1([], []);
    const env = { RL_LOGIN_IP: '1' };
    const first = await post(db, login('someone', 'nope-nope-1234', 'bogus'), env);
    expect(first.status).toBe(422); // challenge refused it
    const second = await post(db, login('someone', 'nope-nope-1234', 'bogus'), env);
    expect(second.status).toBe(429); // …and the IP budget sheds the flood
  });

  it('an unknown identifier is charged the same as a known one (no enumeration oracle)', async () => {
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], []);
    const res = await post(db, login('ghost', 'whatever-password', 'good-token'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_credentials');
    expect(userIpHits(db, 'ghost', '203.0.113.9')).toBe(1);
    expect(identityHits(db, 'ghost')).toBe(1);
  });

  it('an account with no password hash cannot log in — generic 401, same as unknown (F5)', async () => {
    // migration 0012 nulls the seeded admin credential; the login route must
    // treat a NULL hash exactly like a missing account (generic message, same
    // burn-time), never with a distinguishable "no credential set" error.
    (globalThis as any).__turnstileValid = true;
    const db = fakeD1([], [fakeUser('admin', { password_hash: null })]);
    const res = await post(db, login('admin', 'some-guess-1234', 'good-token'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_credentials');
  });
});
