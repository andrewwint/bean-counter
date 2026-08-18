import { access, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool } from './db.ts';
import { listStock } from './readmodel/stock.ts';

/**
 * Analytics handoff (`npm run export:csv`).
 *
 * Dumps the `item_stock` read model as CSV. The agreed exchange point with the
 * analytics lane is a file under `analytics/data/` at the repo root — that
 * folder is owned by the analytics lane, so this script writes into it but
 * never creates it. Override with `EXPORT_PATH`.
 *
 * Equivalent hand-run SQL, if you would rather use psql:
 *   \copy (SELECT item_id, name, category, base_unit, quantity, last_event_at
 *            FROM item_stock ORDER BY category, name)
 *     TO 'analytics/data/item_stock.csv' WITH (FORMAT csv, HEADER true)
 */

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'analytics',
  'data',
  'item_stock.csv',
);

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  const outPath = resolve(process.env.EXPORT_PATH ?? DEFAULT_PATH);

  try {
    await access(dirname(outPath));
  } catch {
    throw new Error(
      `${dirname(outPath)} does not exist. That directory belongs to the analytics lane — ` +
        'create it there, or set EXPORT_PATH to another destination.',
    );
  }

  const rows = await listStock();
  const header = ['item_id', 'name', 'category', 'base_unit', 'quantity', 'last_event_at'];
  const body = rows.map((r) =>
    [r.itemId, r.name, r.category, r.baseUnit, r.quantity, r.lastEventAt].map(csvCell).join(','),
  );

  await writeFile(outPath, [header.join(','), ...body].join('\n') + '\n', 'utf8');
  console.log(`exported ${rows.length} rows to ${outPath}`);
}

try {
  await main();
} finally {
  await closePool();
}
