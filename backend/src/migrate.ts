import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './db.ts';

/**
 * Migration runner: numbered plain `.sql` files in `backend/migrations/`,
 * applied in filename order, each recorded in `schema_migrations`.
 *
 * Plain SQL on purpose. The point of this project is that a reader can open
 * `migrations/002_item_stock.sql` and see the event table and the fold — an ORM
 * would hide exactly the thing we are trying to show.
 *
 * Idempotent: already-applied files are skipped, so `npm run migrate` is safe
 * to run on every boot.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(log: (message: string) => void = console.log): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      // One transaction per file: a migration either lands whole or not at all.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  if (ran.length === 0) log('no pending migrations');
  return ran;
}

// Run directly (`npm run migrate`); importable from tests without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await migrate();
  } finally {
    await closePool();
  }
}
