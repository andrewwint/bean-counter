import pg from 'pg';

/**
 * Create the test database, migrate it, and drop it afterwards.
 *
 * `DATABASE_URL_TEST` selects it (see vitest.config.ts). The admin connection
 * is the same server with the `postgres` maintenance database — nothing about
 * host, port or credentials is hardcoded, so this works against either the
 * native Postgres on 5432 or the compose container on 5433.
 */

const testUrl = process.env.DATABASE_URL_TEST ?? 'postgresql://localhost:5432/bean_counter_test';

function adminUrlFor(url: string): { adminUrl: string; database: string } {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  parsed.pathname = '/postgres';
  return { adminUrl: parsed.toString(), database };
}

export async function setup(): Promise<void> {
  const { adminUrl, database } = adminUrlFor(testUrl);
  const admin = new pg.Client({ connectionString: adminUrl });

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `cannot reach Postgres for the test suite at ${adminUrl}. ` +
        'Start Postgres (native on 5432, or `docker compose up -d postgres` on 5433) and set ' +
        `DATABASE_URL_TEST if it lives elsewhere. Original error: ${(error as Error).message}`,
    );
  }

  try {
    // Identifiers cannot be parameterised; the name comes from our own env, and
    // we quote it defensively anyway.
    const quoted = `"${database.replaceAll('"', '""')}"`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await admin.end();
  }

  // migrate.ts builds its pool from DATABASE_URL at import time, so set it first.
  process.env.DATABASE_URL = testUrl;
  const { migrate } = await import('../src/migrate.ts');
  const { closePool } = await import('../src/db.ts');
  try {
    await migrate(() => {});
  } finally {
    await closePool();
  }
}

export async function teardown(): Promise<void> {
  if (process.env.KEEP_TEST_DB === '1') return;

  const { adminUrl, database } = adminUrlFor(testUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database.replaceAll('"', '""')}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
