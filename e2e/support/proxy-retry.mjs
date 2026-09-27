// `wrangler dev`'s local proxy intermittently answers a dropped request with an
// HTTP 500 whose body is an "Error: Network connection lost." page (AGENTS.md).
// Node's fetch surfaces that as a normal 500 with an unparseable body, so a
// probe that asserts on status codes reads it as a product failure — and on a
// security probe, "the CSRF guard returned 500" is exactly the kind of line a
// human must NOT wave away. Retry that shape; a genuine 5xx with a JSON envelope
// is still a failure.
export function isProxyDrop(res) {
  const body = res?.data ?? res?.body;
  const status = res?.status ?? 0;
  if (status < 500) return false;
  if (body === null || body === undefined) return true;
  return String(body).includes('Network connection lost');
}

/** Run `fn`, retrying up to `times` while the answer looks like a local drop. */
export async function withProxyRetry(label, fn, times = 3) {
  let res = await fn();
  for (let i = 0; i < times && isProxyDrop(res); i++) {
    console.log(`  (local proxy dropped ${label} — retrying)`);
    res = await fn();
  }
  return res;
}
