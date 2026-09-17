// Cron dump keyset pagination: user-scoped tables must page on the
// (user_id, id) tuple — a plain `user_id >` cursor would skip the remaining
// rows of the page's last user. This test pins the predicate shape.
import { describe, it, expect } from 'vitest';
import { tableScan } from '../src/worker/cron';

describe('cron dump keyset', () => {
  it('pages the users table by id', () => {
    const scan = tableScan('users', { userId: null, id: 'u42' });
    expect(scan.where).toBe('id > ?1');
    expect(scan.order).toBe('id');
    expect(scan.binds).toEqual(['u42']);
  });

  it('pages user-scoped tables on the (user_id, id) tuple', () => {
    const scan = tableScan('time_sessions', { userId: 'u7', id: 's9' });
    expect(scan.where).toContain('user_id = ?1');
    expect(scan.where).toContain('id > ?2');
    expect(scan.order).toBe('user_id, id');
    expect(scan.binds).toEqual(['u7', 's9']);
  });

  it('first page has empty cursor binds (matches all rows)', () => {
    const scan = tableScan('tasks', { userId: null, id: null });
    expect(scan.binds).toEqual(['', '']);
  });

  it('the tuple predicate cannot skip rows of the cursor user (regression)', () => {
    // Old predicate: user_id > 'u7\0s9' — false for user_id 'u7' itself.
    // New predicate keeps u7's remaining rows.
    const scan = tableScan('time_sessions', { userId: 'u7', id: 's9' });
    // rows for u7 with id > s9 satisfy the second clause; u8+ satisfy the first
    expect(scan.where).toBe('(user_id > ?1 OR (user_id = ?1 AND id > ?2))');
  });
});
