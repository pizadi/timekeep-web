// Cron dump paging: uniform rowid keyset. The previous (user_id, id) tuple
// assumed an `id` column that task_dependencies/layout/settings don't have —
// the nightly dump could never get past the fifth table (audit F4). rowid
// exists on every dumped table (none is WITHOUT ROWID), which also retires the
// old user-boundary class of bug entirely: a rowid keyset has no per-user
// pages to spill across, so no table needs special-cased predicates.
// test/cron-dump.test.ts drives the real dump end-to-end against a real
// database; this file pins the predicate shape.
import { describe, it, expect } from 'vitest';
import { tableScan } from '../src/worker/cron';

describe('cron dump rowid paging', () => {
  it('pages every table uniformly by rowid', () => {
    const scan = tableScan(42);
    expect(scan.where).toBe('rowid > ?1');
    expect(scan.order).toBe('rowid');
    expect(scan.binds).toEqual([42]);
  });

  it('first page has a zero cursor (matches all rows)', () => {
    const scan = tableScan(0);
    expect(scan.where).toBe('rowid > ?1');
    expect(scan.binds).toEqual([0]);
  });
});
