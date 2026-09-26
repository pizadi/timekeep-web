#!/usr/bin/env node
// CD helper: render the committed wrangler.jsonc template into a deployable
// config for GitHub Actions. Keeps resource ids out of the repo — the
// committed file keeps its REPLACE_ME placeholders and CI injects the real
// ids from GitHub *variables* at deploy time (secrets hold only the API token
// and account id; ids are not sensitive).
//
//   node scripts/render-wrangler.mjs <output-path>   (default: wrangler.ci.jsonc)
//
// Env:
//   D1_DATABASE_ID, KV_NAMESPACE_ID   required — fail with a clear message
//                                     if missing
//   APP_VERSION                       default: package.json version
//   BUILD_SHA                         default: "ci"
//
// The rendered file keeps JSONC comments (wrangler parses them) and is
// gitignored — it carries real ids.
import { readFileSync, writeFileSync } from 'node:fs';

const outPath = process.argv[2] ?? 'wrangler.ci.jsonc';

const need = (name) => {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(
      `render-wrangler: env ${name} is required (GitHub repo variable CF_${name.replace('DATABASE_ID', 'DATABASE_ID').replace('NAMESPACE_ID', 'NAMESPACE_ID')} → check the deploy workflow's mapping)`,
    );
    process.exit(1);
  }
  return v.trim();
};

const d1Id = need('D1_DATABASE_ID');
const kvId = need('KV_NAMESPACE_ID');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const appVersion = process.env.APP_VERSION?.trim() || pkg.version;
const buildSha = process.env.BUILD_SHA?.trim() || 'ci';

let cfg = readFileSync('wrangler.jsonc', 'utf8');

const replace = (regex, replacement, what) => {
  if (!regex.test(cfg)) {
    console.error(`render-wrangler: could not find ${what} in wrangler.jsonc`);
    process.exit(1);
  }
  cfg = cfg.replace(regex, replacement);
};

replace(/"database_id":\s*"REPLACE_ME"/, `"database_id": "${d1Id}"`, 'D1 database_id placeholder');
replace(/"id":\s*"REPLACE_ME"/, `"id": "${kvId}"`, 'KV namespace id placeholder');

// define values are JSON-escaped JS literals: "\"0.4.0\"" means __APP_VERSION__
// is replaced by the expression "0.4.0". Overriding both here means prod never
// depends on the committed define values (which stay for local dev).
const defines = {
  __BUILD_SHA__: JSON.stringify(JSON.stringify(buildSha)),
  __APP_VERSION__: JSON.stringify(JSON.stringify(appVersion)),
};
for (const [key, value] of Object.entries(defines)) {
  replace(new RegExp(`"${key}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`), `"${key}": ${value}`, `${key} define`);
}

if (/"REPLACE_ME"/.test(cfg)) {
  console.error('render-wrangler: rendered config still contains a "REPLACE_ME" value — unhandled placeholder?');
  process.exit(1);
}

writeFileSync(outPath, cfg);
console.log(`render-wrangler: ${outPath} written (version ${appVersion}, build ${buildSha})`);
