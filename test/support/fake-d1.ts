// Minimal in-memory D1 double for the concurrency-sensitive worker helpers.
//
// It is deliberately NOT a SQL engine: it understands exactly the statements
// the units under test issue (auth_sessions lookups/updates, a users lookup) and
// gives the test a hook to inject a concurrent mutation at a chosen point —
// which is what a real interleaving test needs and what no amount of sequential
// HTTP testing can express.
//
// A factory rather than a class: the D1 statement builder is built from nested
// closures, and a closure-based object keeps them free of `this` juggling.

export interface FakeSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string;
  ip: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface FakeUserRow {
  id: string;
  username: string;
  email: string;
  name: string;
  timezone: string;
  week_start: number;
  theme: string;
  role: 'user' | 'admin';
  active: number;
  must_change_password: number;
  email_verified_at: number | null;
  created_at: number;
}

export interface FakeD1 {
  readonly sessions: Map<string, FakeSessionRow>;
  readonly users: Map<string, FakeUserRow>;
  /** Every statement the code under test ran, in order (for assertions). */
  readonly log: string[];
  /** Injected before a statement's effect is applied — the "other request". */
  beforeApply: ((sql: string) => void | Promise<void>) | null;
  prepare(sql: string): any;
  /** Session rows as a list (for assertions). */
  rows(): FakeSessionRow[];
  /** The same object, typed for the `D1Database` parameter the helpers take. */
  db: D1Database;
}

export function fakeD1(sessionRows: FakeSessionRow[] = [], userRows: FakeUserRow[] = []): FakeD1 {
  const sessions = new Map(sessionRows.map((r) => [r.id, { ...r }]));
  const users = new Map(userRows.map((u) => [u.id, { ...u }]));
  const log: string[] = [];
  const state = {
    beforeApply: null as ((sql: string) => void | Promise<void>) | null,
  };

  const prepare = (sql: string): any => {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const stmt = {
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt._args = args;
        return stmt;
      },
      async run(): Promise<any> {
        log.push(norm);
        if (state.beforeApply) await state.beforeApply(norm);
        if (norm.startsWith('UPDATE auth_sessions SET token_hash')) {
          // SET token_hash=?1, user_agent=?2, ip=?3, last_seen_at=?4, expires_at=?5
          // WHERE id=?6 AND token_hash=?7
          const [hash, ua, ip, lastSeen, expiresAt, id, prevHash] = stmt._args as string[];
          const row = sessions.get(id);
          if (!row || row.token_hash !== prevHash) return { meta: { changes: 0, last_row_id: 0 } };
          row.token_hash = hash;
          row.user_agent = ua;
          row.ip = ip;
          row.last_seen_at = Number(lastSeen);
          row.expires_at = Number(expiresAt);
          return { meta: { changes: 1, last_row_id: 0 } };
        }
        if (norm.startsWith('UPDATE auth_sessions SET last_seen_at')) {
          const [seen, id] = stmt._args as string[];
          const row = sessions.get(id);
          if (!row) return { meta: { changes: 0, last_row_id: 0 } };
          row.last_seen_at = Number(seen);
          return { meta: { changes: 1, last_row_id: 0 } };
        }
        if (norm.startsWith('INSERT INTO auth_sessions')) {
          const [id, userId, hash, ua, ip, createdAt, expiresAt] = stmt._args as string[];
          sessions.set(id, {
            id,
            user_id: userId,
            token_hash: hash,
            user_agent: ua,
            ip,
            created_at: Number(createdAt),
            last_seen_at: Number(createdAt),
            expires_at: Number(expiresAt),
          });
          return { meta: { changes: 1, last_row_id: 1 } };
        }
        if (norm.startsWith('DELETE FROM auth_sessions')) {
          const [id] = stmt._args as string[];
          const changes = sessions.delete(id) ? 1 : 0;
          return { meta: { changes, last_row_id: 0 } };
        }
        throw new Error(`fakeD1: unsupported statement: ${norm}`);
      },
      async first<T>(): Promise<T | null> {
        log.push(norm);
        if (state.beforeApply) await state.beforeApply(norm);
        if (norm.startsWith('SELECT 1 AS ok FROM auth_sessions')) {
          const [id] = stmt._args as string[];
          return (sessions.has(id) ? { ok: 1 } : null) as T | null;
        }
        if (norm.includes('FROM auth_sessions s WHERE s.token_hash')) {
          const [hash] = stmt._args as string[];
          const row = [...sessions.values()].find((s) => s.token_hash === hash);
          return (
            row
              ? {
                  id: row.id,
                  user_id: row.user_id,
                  token_hash: row.token_hash,
                  expires_at: row.expires_at,
                  last_seen_at: row.last_seen_at,
                }
              : null
          ) as T | null;
        }
        if (norm.includes('FROM users WHERE id')) {
          const [id] = stmt._args as string[];
          return (users.get(id) ?? null) as T | null;
        }
        throw new Error(`fakeD1: unsupported first(): ${norm}`);
      },
    };
    return stmt;
  };

  const fake: FakeD1 = {
    sessions,
    users,
    log,
    get beforeApply() {
      return state.beforeApply;
    },
    set beforeApply(fn: ((sql: string) => void | Promise<void>) | null) {
      state.beforeApply = fn;
    },
    prepare,
    rows: () => [...sessions.values()],
    get db() {
      return fake as unknown as D1Database;
    },
  };
  return fake;
}

/** A session row inside the rotation window (expires in `inDays` days). */
export function expiringSession(id: string, userId: string, tokenHash: string, now: number, inDays: number) {
  return {
    id,
    user_id: userId,
    token_hash: tokenHash,
    user_agent: 'test',
    ip: '127.0.0.1',
    created_at: now - 20 * 24 * 3600_000,
    last_seen_at: now - 60_000,
    expires_at: now + inDays * 24 * 3600_000,
  };
}

export function fakeUser(id: string, over: Partial<FakeUserRow> = {}): FakeUserRow {
  const now = Date.now();
  return {
    id,
    username: id,
    email: `${id}@example.com`,
    name: 'Test',
    timezone: 'UTC',
    week_start: 1,
    theme: 'system',
    role: 'user',
    active: 1,
    must_change_password: 0,
    email_verified_at: now,
    created_at: now - 3600_000,
    ...over,
  };
}
