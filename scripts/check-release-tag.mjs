#!/usr/bin/env node
// Release-tag guard for the Deploy workflow (runs only on a vX.Y.Z tag push).
// The `tags` filter in deploy.yml is glob-based — `v*` would also match a
// stray `v0.5.3.dev1` tag, and a tag that doesn't match package.json would
// deploy the wrong release. Both cases fail here before anything runs:
//   1. the tagged commit's package.json version is a clean x.y.z (no .devN —
//      dev iterations are commit-only and must never deploy), and
//   2. that version equals the pushed tag (v + version).
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = process.env.GITHUB_REF_NAME ?? '';

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `check-release-tag: package.json version is "${version}" — releases deploy from` +
      ` clean x.y.z versions only (dev iterations like "${version}.dev1" must never be tagged).`,
  );
  process.exit(1);
}

if (tag && tag !== `v${version}`) {
  console.error(
    `check-release-tag: tag "${tag}" does not match package.json version "${version}"` +
      ` (expected "v${version}"). Tag the release commit that bumps the version.`,
  );
  process.exit(1);
}

console.log(`check-release-tag: ${tag || '(no tag)'} matches package.json (${version})`);
