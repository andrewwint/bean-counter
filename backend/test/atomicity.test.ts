import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { listStock } from '../src/readmodel/stock.ts';
import { record, resetDatabase } from './helpers.ts';

/**
 * The response must never contradict the log.
 *
 * The original write path committed the insert on the pool's autocommit path
 * and refreshed the read model afterwards, so a refresh failure answered
 * `500 INTERNAL` for an event that was already durable — the client believed
 * nothing happened while the delivery sat in the log. Append and refresh now
 * share one transaction, so a 500 is the truth.
 */

const app = createApp();

const post = (body: unknown) =>
  app.request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const countEvents = async (): Promise<number> => {
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::bigint AS count FROM events',
  );
  return rows[0]!.count;
};

/**
 * Break the refresh the way a real failure would — after the insert has already
 * happened inside the transaction. Renaming the view is the cheapest way to
 * make `REFRESH MATERIALIZED VIEW item_stock` fail without touching the log.
 */
async function withBrokenReadModel(body: () => Promise<void>): Promise<void> {
  await pool.query('ALTER MATERIALIZED VIEW item_stock RENAME TO item_stock_broken');
  try {
    await body();
  } finally {
    await pool.query('ALTER MATERIALIZED VIEW item_stock_broken RENAME TO item_stock');
  }
}

beforeEach(resetDatabase);
afterAll(closePool);

describe('append + refresh atomicity', () => {
  it('does not persist the event when the read-model refresh fails', async () => {
    await record({
      type: 'ItemDefined',
      itemId: 'bean-sumatra',
      name: 'Sumatra Mandheling',
      category: 'beans',
      baseUnit: 'g',
    });
    const before = await countEvents();

    // The route logs the failure; keep the suite output readable.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await withBrokenReadModel(async () => {
      const response = await post({
        type: 'StockReceived',
        itemId: 'bean-sumatra',
        quantity: 12000,
        occurredAt: '2026-08-05T13:20:00.000Z',
      });

      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('INTERNAL');

      // The claim the old code could not make: a 500 means nothing happened.
      expect(await countEvents()).toBe(before);
    });

    logged.mockRestore();
  });

  it('leaves the log and the read model usable after a rolled-back append', async () => {
    await record({
      type: 'ItemDefined',
      itemId: 'bean-huila',
      name: 'Huila',
      category: 'beans',
      baseUnit: 'g',
    });

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withBrokenReadModel(async () => {
      const response = await post({ type: 'StockReceived', itemId: 'bean-huila', quantity: 500 });
      expect(response.status).toBe(500);
    });
    logged.mockRestore();

    // The next write succeeds and the board is correct: the rollback released
    // everything it held, including the view's exclusive lock.
    const retried = await post({ type: 'StockReceived', itemId: 'bean-huila', quantity: 500 });
    expect(retried.status).toBe(201);

    const rows = await listStock();
    expect(rows.map((r) => [r.itemId, r.quantity])).toEqual([['bean-huila', 500]]);
  });
});
