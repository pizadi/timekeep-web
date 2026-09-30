// One-time admin credential bootstrap (audit F5).
//
// Migration 0012 removed the seeded admin password — a fresh install has an
// admin row with a NULL password_hash, which can never log in. This script
// sets the FIRST usable credential:
//
//   npm run admin:create                      # generated passphrase, printed ONCE
//   npm run admin:create -- --remote          # production (run under proxychains)
//   printf '%s' "$PW" | npm run admin:create -- --local --stdin --force
//
// Modes:
//   (default)        generate a strong random passphrase, print it once, set it
//   --stdin          read the passphrase from stdin (never argv — a process
//                    list is readable by every other process of the same user)
//   --local|--remote target database (default --local). --remote runs against
//                    the REAL database via wrangler.local.jsonc; route the
//                    whole invocation through proxychains (AGENTS.md).
//   --persist-to DIR local-only: target a dedicated wrangler state directory
//                    (used by the e2e suite's disposable instances).
//   --force          replace an EXISTING credential (otherwise refuses, so a
//                    surprise re-run can't silently rotate a live admin).
//
// The hash is computed with the worker's own pbkdf2Chain, so the stored
// format is exactly what verifyPassword expects. `must_change_password` is
// cleared: the operator just received (or chose) the password — there is
// nothing to force.
//
// Node ≥ 22.12 required (engines): the .ts import below relies on
// --experimental-strip-types.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/worker/pbkdf2.ts';

const pexec = promisify(execFile);

interface Options {
  target: 'local' | 'remote';
  stdin: boolean;
  force: boolean;
  persistTo?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { target: 'local', stdin: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.target = 'local';
    else if (a === '--remote') opts.target = 'remote';
    else if (a === '--stdin') opts.stdin = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--persist-to') opts.persistTo = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Run `wrangler d1 execute` with the right target flags. `capture` keeps stdout for --json parsing. */
async function wranglerD1(opts: Options, sql: string, capture: boolean): Promise<string> {
  const args = [
    'wrangler',
    'd1',
    'execute',
    'timekeep',
    opts.target === 'remote' ? '--remote' : '--local',
    ...(opts.target === 'remote' ? ['-c', 'wrangler.local.jsonc'] : []),
    ...(opts.persistTo ? ['--persist-to', opts.persistTo] : []),
    '--command',
    sql,
    '--json',
  ];
  const res = await pexec('npx', args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
  });
  return capture ? res.stdout : '';
}

function firstRow(json: string): Record<string, unknown> | null {
  // wrangler --json prints `[ { "results": [ … ], "success": true, … } ]`
  try {
    const parsed = JSON.parse(json);
    const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
    const row = Array.isArray(results) ? results[0] : null;
    return (row as Record<string, unknown>) ?? null;
  } catch {
    throw new Error(`could not parse wrangler output as JSON (first 200 chars): ${json.slice(0, 200)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. inspect the current admin row
  const row = firstRow(
    await wranglerD1(opts, "SELECT password_hash FROM users WHERE username = 'admin' AND role = 'admin'", true),
  );
  if (!row) {
    console.error('no admin row found — run the migrations first (npm run db:migrate:local / :remote)');
    process.exit(1);
  }
  if (row.password_hash && !opts.force) {
    console.error(
      'the admin account already has a credential — refusing to replace it. Pass --force only if that is intended.',
    );
    process.exit(1);
  }

  // 2. obtain the passphrase — generated, or read from stdin; NEVER argv
  let password: string;
  if (opts.stdin) {
    password = (
      await new Promise<string>((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (buf += c));
        process.stdin.on('end', () => resolve(buf));
        process.stdin.on('error', reject);
      })
    ).trim();
    if (!password) {
      console.error('no passphrase received on stdin');
      process.exit(2);
    }
  } else {
    // 18 bytes = 144 bits of entropy, base64url-safe (no shell/email mangling)
    password = randomBytes(18).toString('base64url');
  }

  // 3. hash with the worker's own scheme (format-driven verification: the
  // iteration count travels in the stored string)
  const iterations = Number(process.env.PBKDF2_ITERATIONS) || 600_000;
  const hash = await hashPassword(password, iterations);

  // 4. set it (the hash is hex + '$' — no SQL-quoting hazards, but escape anyway)
  await wranglerD1(
    opts,
    `UPDATE users SET password_hash = '${hash.replaceAll("'", "''")}', must_change_password = 0, updated_at = ${Date.now()} WHERE username = 'admin' AND role = 'admin'`,
    false,
  );

  if (opts.stdin) {
    console.log(`admin credential set (${opts.target}${opts.persistTo ? `, persist-to ${opts.persistTo}` : ''}).`);
  } else {
    console.log(
      [
        `admin credential set (${opts.target}${opts.persistTo ? `, persist-to ${opts.persistTo}` : ''}).`,
        '',
        '  username:  admin',
        `  password:  ${password}`,
        '',
        'Shown ONCE — store it in a password manager now; it cannot be recovered or reprinted.',
      ].join('\n'),
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
