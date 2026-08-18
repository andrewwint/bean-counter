import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { MAX_QUANTITY } from '../src/events/schema.ts';
import { listStock, refreshItemStock } from '../src/readmodel/stock.ts';
import { quantityOf, resetDatabase } from './helpers.ts';

/**
 * The unrecoverable failure this bound exists to prevent.
 *
 * An integer with no upper bound passes `.int().positive()`, commits into the
 * append-only log, and then overflows `(payload ->> 'quantity')::bigint` in the
 * fold. From that point REFRESH fails forever and every later append fails with
 * it — and nothing can delete the offending row, because `events` is
 * append-only. So the assertion is not just "400": it is that the log and the
 * read model are still usable afterwards.
 */

const POISON = 1e19; // > MAX_SAFE_INTEGER, still inside a double, still valid JSON

const app = createApp();

const post = (body: unknown) =>
  app.request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const countEvents = async (): Promise<number> => {
  const { rows } = await pool.query<{ count: number }>('SELECT count(*)::bigint AS count FROM events');
  return rows[0]!.count;
};

beforeEach(resetDatabase);
afterAll(closePool);

describe('quantity bounds', () => {
  it('rejects an out-of-range quantity and leaves the log and the read model working', async () => {
    await post({ type: 'ItemDefined', itemId: 'beans', name: 'Beans', category: 'beans', baseUnit: 'g' });
    const before = await countEvents();

    const poisoned = await post({ type: 'StockReceived', itemId: 'beans', quantity: POISON });
    expect(poisoned.status).toBe(400);
    expect(((await poisoned.json()) as { error: { code: string } }).error.code).toBe('INVALID_EVENT');

    // Nothing was appended. This is the part that cannot be repaired later.
    expect(await countEvents()).toBe(before);

    // The log still accepts writes, and the view still refreshes.
    const valid = await post({ type: 'StockReceived', itemId: 'beans', quantity: 12000 });
    expect(valid.status).toBe(201);
    expect(await countEvents()).toBe(before + 1);

    await expect(refreshItemStock()).resolves.toBeUndefined();
    expect(await quantityOf('beans')).toBe(12000);
    expect(await listStock()).toHaveLength(1);
  });

  it('rejects an out-of-range countedQuantity the same way', async () => {
    const response = await post({ type: 'StockCounted', itemId: 'beans', countedQuantity: POISON });
    expect(response.status).toBe(400);
    expect(await countEvents()).toBe(0);
  });

  it('accepts MAX_QUANTITY itself — the bound is inclusive and inside int8', async () => {
    await post({ type: 'ItemDefined', itemId: 'edge', name: 'Edge', category: 'test', baseUnit: 'each' });
    const response = await post({ type: 'StockCounted', itemId: 'edge', countedQuantity: MAX_QUANTITY });
    expect(response.status).toBe(201);
    expect(await quantityOf('edge')).toBe(MAX_QUANTITY);
  });

  it('refuses an out-of-range payload at the storage boundary too, with validation bypassed', async () => {
    // Defence in depth: migrations/003 has to hold even if something ever
    // appends without going through zod.
    await expect(
      pool.query(
        `INSERT INTO events (event_id, stream_id, event_type, payload, occurred_at)
         VALUES (gen_random_uuid(), 'beans', 'StockReceived', $1::jsonb, now())`,
        [JSON.stringify({ itemId: 'beans', quantity: POISON })],
      ),
    ).rejects.toThrow(/events_quantity_in_range/);

    await expect(
      pool.query(
        `INSERT INTO events (event_id, stream_id, event_type, payload, occurred_at)
         VALUES (gen_random_uuid(), 'beans', 'StockCounted', $1::jsonb, now())`,
        [JSON.stringify({ itemId: 'beans', countedQuantity: POISON })],
      ),
    ).rejects.toThrow(/events_counted_quantity_in_range/);

    expect(await countEvents()).toBe(0);
  });
});
