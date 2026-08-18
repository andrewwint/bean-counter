import { pool } from '../src/db.ts';
import { appendEventAndRefresh } from '../src/events/append.ts';
import { validateEvent } from '../src/events/schema.ts';
import { refreshItemStock } from '../src/readmodel/stock.ts';

/**
 * Reset between tests. TRUNCATE is a test-harness affordance only — production
 * code never deletes from `events` (append-only), which is why this lives here
 * and not in src/.
 */
export async function resetDatabase(): Promise<void> {
  await pool.query('TRUNCATE events RESTART IDENTITY');
  await refreshItemStock();
}

/** Validate-then-append, the same path the HTTP route takes. */
export async function record(raw: Record<string, unknown>): Promise<void> {
  await appendEventAndRefresh(validateEvent(raw));
}

export async function quantityOf(itemId: string): Promise<number | undefined> {
  const { rows } = await pool.query<{ quantity: number }>(
    'SELECT quantity FROM item_stock WHERE item_id = $1',
    [itemId],
  );
  return rows[0]?.quantity;
}

export const at = (iso: string): string => new Date(iso).toISOString();
