import { defineConfig } from 'vitest/config';

/**
 * Tests run against a REAL Postgres — no mocks. A mocked event store would
 * test our belief about SQL, not the SQL that ships.
 *
 * The suite uses its own database so it can truncate freely and never touches
 * dev data. Point it with `DATABASE_URL_TEST` (default:
 * postgresql://localhost:5432/bean_counter_test). `test/global-setup.ts`
 * creates that database, migrates it, and drops it again at the end.
 */
const testDatabaseUrl =
  process.env.DATABASE_URL_TEST ?? 'postgresql://localhost:5432/bean_counter_test';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: testDatabaseUrl },
    // One database, shared truncation: files must not run concurrently.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
