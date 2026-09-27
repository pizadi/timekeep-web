// INV-11: a mutation and the event that announces it are committed together.
//
// The client's ONLY recovery path is `GET /sync?since=<cursor>` — a pure cursor
// walk over sync_log that never refetches entities. So when a route wrote the
// entity in one round trip and appended the event in a second, any failure
// between the two left a change that was never announced and never would be:
// not eventually consistent, permanently divergent until a full page reload.
// (D1 runs a batch as a single transaction, so one batch closes the window.)
//
// This test is a CONVENTION guard rather than a behavioural one: it fails when
// a route handler writes an entity and then calls the standalone event writer
// outside the same batch. That is the shape the audit called out, and it is
// easy to reintroduce by copying a neighbouring handler.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_DIR = 'src/worker/routes';
const EVENT_WRITERS = /\bappendEvents\s*\(/;

/**
 * `import.completed` and `restore.completed` are completion signals for
 * multi-batch operations (up to 200k sessions, chunked 200 rows at a time), so
 * they cannot share a batch with the rows they describe — the event is only
 * true once every chunk has committed. Clients react to both with a full
 * refetch, so a lost one is stale-until-reload, not divergence. Everything
 * else must be batched with its entity write.
 */
const ALLOWED_STANDALONE = /^\s*\/\/ (INV-11|EVENT-ATOMICITY-ALLOWED)/m;

describe('event atomicity convention (INV-11)', () => {
  it('no route handler calls the standalone appendEvents (use commitWithEvents)', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
      // the import itself is fine; a CALL is what reintroduces the two-batch shape
      const stripped = src.replace(/^import[\s\S]*?from '[^']*events';\s*$/gm, '');
      if (!EVENT_WRITERS.test(stripped)) continue;
      // an explicitly documented multi-batch completion signal is allowed
      if (ALLOWED_STANDALONE.test(stripped)) continue;
      offenders.push(file);
    }
    expect(
      offenders,
      'these handlers append events in a second round trip — use commitWithEvents so the entity write and its event share one batch (a documented multi-batch completion signal is the only exception)',
    ).toEqual([]);
  });

  it('commitWithEvents is the helper routes import for entity+event writes', () => {
    const src = readFileSync('src/worker/events.ts', 'utf8');
    // the helper itself must build ONE batch containing both halves
    const body = src.slice(src.indexOf('export async function commitWithEvents'));
    expect(body).toMatch(/env\.DB\.batch\(\[\.\.\.entityStmts, \.\.\.syncLogStmts/);
  });
});
