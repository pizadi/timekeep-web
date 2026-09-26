// INV-01 over real HTTP: a revoked session can never produce a valid
// replacement session.
//
// Runs against a DEDICATED wrangler dev instance (own port, own D1 state) that
// run-e2e.sh seeds with auth_sessions rows whose `expires_at` is already inside
// the 7-day rotation window — the seeded admin's own account cannot be pushed
// there, and waiting out 23 days of a 30-day TTL is not an option. (That is why
// the rotation itself is unit-tested against a D1 double in
// test/session-rotation.test.ts; here we assert the HTTP-visible post-condition,
// which is what actually matters and needs no instrumentation.)
//
// Each round races two requests from the SAME user, because that is the only
// pair that is symmetric and fast:
//   A  an ordinary authenticated request — requireAuth rotates its token
//   B  DELETE /me/sessions/<A's id> — revokes exactly A's session
//
// A single-session revoke is the shape that has teeth in BOTH orders. The old
// INSERT+DELETE rotation gave the replacement row a NEW id, so
//   - revoke first  → the rotation inserted a live session anyway
//   - rotate first  → the revoke (by the old id) matched nothing
// …and the rotated token kept working either way. The compare-and-swap
// rotation keeps the row id, so the revoke always catches the renamed row and
// the rotated token is always dead.
//
// B's own seeded session survives every round, so it can run them all and then
// list the user's sessions: exactly one must be left.
const BASE = process.env.TK_BASE ?? 'http://127.0.0.1:8789/api';
const ORIGIN = new URL(BASE).origin;
/** Seeded sessions inside the rotation window: [{ id, token }]; the last is the revoker. */
const SEEDED = JSON.parse(process.env.TK_SEEDED_SESSIONS ?? '[]');
const ROUNDS = Number(process.env.TK_ROUNDS ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail = 1;
}

/** fetch() + a cookie jar, reporting the tk_session value the response set. */
async function call(jar, method, path, data) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      origin: ORIGIN,
      'x-device-id': 'race',
      'x-csrf-token': jar.csrf ?? '',
      ...(jar.cookies?.length ? { cookie: jar.cookies.join('; ') } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: 'manual',
  });
  let rotated = null;
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (name === 'tk_csrf') jar.csrf = value;
    if (name === 'tk_session') rotated = value;
    jar.cookies = (jar.cookies ?? []).filter((p) => !p.startsWith(`${name}=`));
    jar.cookies.push(`${name}=${value}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body, rotated };
}

/** A jar holding exactly one session cookie — a real cross-site cookie jar. */
function jarFor(token) {
  return { cookies: [`tk_session=${token}`], csrf: '' };
}

async function callRetry(jar, method, path, data) {
  // `wrangler dev`'s local proxy intermittently answers with a bodiless 5xx
  // ("Network connection lost" — AGENTS.md). A local artifact, not a product
  // behavior: retry once before calling the round a failure.
  const first = await call(jar, method, path, data);
  if (first.status >= 500 && first.body === null) return call(jar, method, path, data);
  return first;
}

async function main() {
  if (SEEDED.length < 2) {
    console.error('session-race test: TK_SEEDED_SESSIONS needs at least 2 entries (run via scripts/run-e2e.sh)');
    process.exit(1);
  }
  // The revoker's own session: it survives every round, so it stays usable.
  const revoker = jarFor(SEEDED[SEEDED.length - 1].token);
  const health = await call(revoker, 'GET', '/me');
  check(
    'the seeded sessions authenticate (fixture sanity)',
    health.status === 200,
    `status ${health.status} ${JSON.stringify(health.body)}`,
  );
  if (health.status !== 200) process.exit(1);

  let revoked = 0;
  let rotatedFirst = 0;
  let resurrected = 0;
  let skipped = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const target = SEEDED[i % (SEEDED.length - 1)];
    const a = jarFor(target.token);
    // Random micro-stagger: sweeps the revocation across the whole span of A's
    // request instead of always racing it to the finish line.
    const stagger = Math.floor(Math.random() * 8);
    const rot = call(a, 'GET', '/me');
    await sleep(stagger);
    const rev = callRetry(revoker, 'DELETE', `/me/sessions/${target.id}`);
    const [ar, rr] = await Promise.all([rot, rev]);

    if (rr.status !== 200) {
      skipped++;
      console.log(`  round ${i}: revoke answered ${rr.status} ${JSON.stringify(rr.body)}`);
      continue;
    }
    if (ar.status === 401) {
      // the CAS found the row gone — revocation won, nothing was minted
      revoked++;
      continue;
    }
    if (ar.status !== 200) {
      skipped++;
      console.log(`  round ${i}: rotating request answered ${ar.status} ${JSON.stringify(ar.body)}`);
      continue;
    }
    if (!ar.rotated || ar.rotated === target.token) {
      skipped++;
      console.log(`  round ${i}: 200 without a rotated cookie`);
      continue;
    }
    rotatedFirst++;
    // A rotated first, so the revoke that followed (by the same row id) must
    // have killed the renamed row.
    const probe = jarFor(ar.rotated);
    const after = await call(probe, 'GET', '/me');
    if (after.status === 200 || after.status === 403) {
      resurrected++;
      console.log(`  round ${i}: ROTATED TOKEN STILL AUTHENTICATES (${after.status}) — session resurrected`);
    }
  }

  check('every round raced a revocation (no skipped rounds)', skipped === 0, `${skipped} round(s) skipped`);
  check(
    'a rotation that ran after the revocation produced nothing usable',
    resurrected === 0,
    `${resurrected} resurrected session(s) of ${ROUNDS} rounds`,
  );
  console.log(
    `  ${revoked} round(s): revocation won · ${rotatedFirst} round(s): rotation ran first, token then revoked`,
  );
  check(
    'both interleavings were observed (the race is real, not one-sided)',
    revoked > 0 && rotatedFirst > 0,
    `${revoked} vs ${rotatedFirst}`,
  );

  const sessions = await call(revoker, 'GET', '/me/sessions');
  const own = sessions.body?.sessions?.length ?? -1;
  check(
    'exactly one session survives all the revocations (nothing was resurrected)',
    own === 1,
    `${own} session(s) — ${JSON.stringify(sessions.body)}`,
  );
}

await main();
console.log(fail ? '\nsession-race test FAILED' : '\nsession-race test passed');
process.exit(fail);
