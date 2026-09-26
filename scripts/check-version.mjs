#!/usr/bin/env node
// CI guard for the release discipline (AGENTS.md "Deploy & versioning"):
// package.json is the version source of truth and the __APP_VERSION__ define
// in wrangler.jsonc must match it. Both bump together on release; dev
// iterations (x.y.z.devN) live in commit messages only and must NOT bump
// either. wrangler.local.jsonc is gitignored (absent in CI), so only the
// committed config is checked — the error message reminds humans of all three.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const wrangler = readFileSync('wrangler.jsonc', 'utf8');

// The define value is a JSON-escaped JS literal — `"\"0.3.0\""` in the file,
// i.e. wrangler replaces __APP_VERSION__ with the expression "0.3.0". Decode
// the JSON string, then strip the literal's quotes.
const m = wrangler.match(/"__APP_VERSION__"\s*:\s*"((?:[^"\\]|\\.)*)"/);
if (!m) {
  console.error('check-version: __APP_VERSION__ define not found in wrangler.jsonc');
  process.exit(1);
}
const defineValue = JSON.parse(`"${m[1]}"`).replace(/^"|"$/g, '');

if (defineValue !== pkg.version) {
  console.error(
    `check-version: version drift — package.json is "${pkg.version}" but ` +
      `wrangler.jsonc __APP_VERSION__ is "${defineValue}". Bump all three together: ` +
      `package.json + the define block in wrangler.jsonc AND wrangler.local.jsonc.`,
  );
  process.exit(1);
}

console.log(`check-version: in sync (${pkg.version})`);
