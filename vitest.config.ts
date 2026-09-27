import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several suites here are integration-bound, not micro-benchmarks:
    // test/migrations.test.ts shells out to the `sqlite3` CLI once per
    // statement, and the password suite does real chained PBKDF2 at 600k
    // iterations. Their duration therefore scales with machine load, and under
    // Vitest 5's default parallel forks the migration suite went from ~1.2 s
    // alone to >5 s on a loaded box — i.e. it failed on timing, not on
    // behaviour, which is the worst possible way for a test to fail.
    // 30 s leaves ~10x headroom over the slowest observed run.
    testTimeout: 30_000,
    // same reasoning for setup/teardown
    hookTimeout: 30_000,
  },
});
