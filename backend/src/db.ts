import pg from 'pg';

/**
 * The one Postgres pool for the process.
 *
 * Connection comes from `DATABASE_URL`. Nothing is hardcoded here: if
 * `DATABASE_URL` is absent we fall through to node-postgres' own `PG*`
 * environment defaults, which already point at localhost:5432 — the compose
 * Postgres. See `.env.example`.
 */

// bigint (int8) arrives from pg as a string so precision is never lost. Our
// quantities are small integers in a base unit, so parsing to Number is safe
// and keeps JSON responses numeric rather than stringly-typed.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export const pool = new pg.Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
);

export async function closePool(): Promise<void> {
  await pool.end();
}
