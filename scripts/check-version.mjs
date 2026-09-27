#!/usr/bin/env node
// CI guard for the release discipline (AGENTS.md "Deploy & versioning"):
// package.json is the version source of truth and BOTH the __APP_VERSION__
// define in wrangler.jsonc and package-lock.json's own version must match it.
// They bump together on release; dev iterations (x.y.z.devN) live in commit
// messages only and must NOT bump any of them. wrangler.local.jsonc is
// gitignored (absent in CI), so only the committed config is checked — the
// error message reminds humans of all three.
//
// The lockfile is checked because it went stale silently: 0.5.3 shipped with a
// lockfile still saying 0.5.2. Nothing broke, which is exactly why it needs a
// guard — the drift is invisible until some tool reads the wrong number (INV-14).
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const wrangler = readFileSync('wrangler.jsonc', 'utf8');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

// The define value is a JSON-escaped JS literal — `"\"0.3.0\""` in the file,
// i.e. wrangler replaces __APP_VERSION__ with the expression "0.3.0". Decode
// the JSON string, then strip the literal's quotes.
const m = wrangler.match(/"__APP_VERSION__"\s*:\s*"((?:[^"\\]|\\.)*)"/);
if (!m) {
  console.error('check-version: __APP_VERSION__ define not found in wrangler.jsonc');
  process.exit(1);
}
const defineValue = JSON.parse(`"${m[1]}"`).replace(/^"|"$/g, '');

const drift = [];
if (defineValue !== pkg.version) drift.push(`wrangler.jsonc __APP_VERSION__ is "${defineValue}"`);
// lockfileVersion 3 keeps the root version in two places; check the one under
// packages[""] as well, since that is what tooling reads
for (const [where, value] of [
  ['package-lock.json version', lock.version],
  ['package-lock.json packages[""].version', lock.packages?.['']?.version],
]) {
  if (value !== undefined && value !== pkg.version) drift.push(`${where} is "${value}"`);
}

if (drift.length) {
  console.error(
    `check-version: version drift — package.json is "${pkg.version}" but ` +
      `${drift.join(', and ')}. Bump them together: package.json + ` +
      `package-lock.json (npm install --package-lock-only) + the define block in ` +
      `wrangler.jsonc AND wrangler.local.jsonc.`,
  );
  process.exit(1);
}

console.log(`check-version: in sync (${pkg.version})`);
