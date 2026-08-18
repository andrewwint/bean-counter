import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.ts';
import { quantityOf, record, resetDatabase } from './helpers.ts';

/**
 * The fold, exercised against real SQL in `item_stock`. These assertions are
 * about the materialized view in migrations/002_item_stock.sql, not about any
 * TypeScript reimplementation of it.
 */

const define = (itemId: string, baseUnit: 'g' | 'ml' | 'each' = 'g') => ({
  type: 'ItemDefined',
  itemId,
  name: itemId,
  category: 'test',
  baseUnit,
});

beforeEach(resetDatabase);
afterAll(closePool);

describe('item_stock fold', () => {
  it('folds from zero over all events when the item has never been counted', async () => {
    await record(define('never-counted'));
    await record({ type: 'StockReceived', itemId: 'never-counted', quantity: 12000 });
    await record({ type: 'StockReceived', itemId: 'never-counted', quantity: 6000 });
    await record({ type: 'StockDepleted', itemId: 'never-counted', quantity: 1800, reason: 'sale' });
    await record({ type: 'StockDepleted', itemId: 'never-counted', quantity: 400, reason: 'waste' });

    expect(await quantityOf('never-counted')).toBe(15800);
  });

  it('treats a count as a new baseline and applies only later deltas', async () => {
    await record(define('counted'));
    await record({ type: 'StockReceived', itemId: 'counted', quantity: 12000 });
    await record({ type: 'StockDepleted', itemId: 'counted', quantity: 5000, reason: 'sale' });
    // Everything above is now irrelevant: the shelf says 4000.
    await record({ type: 'StockCounted', itemId: 'counted', countedQuantity: 4000 });

    expect(await quantityOf('counted')).toBe(4000);

    await record({ type: 'StockReceived', itemId: 'counted', quantity: 1000 });
    await record({ type: 'StockDepleted', itemId: 'counted', quantity: 250, reason: 'sale' });

    expect(await quantityOf('counted')).toBe(4750);
  });

  it('lets the most recent of several counts win', async () => {
    await record(define('recounted'));
    await record({ type: 'StockCounted', itemId: 'recounted', countedQuantity: 9000 });
    await record({ type: 'StockDepleted', itemId: 'recounted', quantity: 2000, reason: 'sale' });
    await record({ type: 'StockCounted', itemId: 'recounted', countedQuantity: 6500 });

    expect(await quantityOf('recounted')).toBe(6500);
  });

  it('keeps items independent', async () => {
    await record(define('beans', 'g'));
    await record(define('milk', 'ml'));
    await record({ type: 'StockReceived', itemId: 'beans', quantity: 1000 });
    await record({ type: 'StockReceived', itemId: 'milk', quantity: 4000 });
    await record({ type: 'StockDepleted', itemId: 'milk', quantity: 500, reason: 'sample' });

    expect(await quantityOf('beans')).toBe(1000);
    expect(await quantityOf('milk')).toBe(3500);
  });

  it('surfaces the reconciliation gap when a count disagrees with the log', async () => {
    // A week of movement the log is sure about...
    await record(define('yirgacheffe'));
    await record({ type: 'StockCounted', itemId: 'yirgacheffe', countedQuantity: 12000 });
    await record({ type: 'StockReceived', itemId: 'yirgacheffe', quantity: 6000 });
    await record({ type: 'StockDepleted', itemId: 'yirgacheffe', quantity: 1800, reason: 'sale' });

    // ...predicts 16200 on the shelf.
    expect(await quantityOf('yirgacheffe')).toBe(16200);
    const predicted = 16200;

    // The shelf says 15850. Shrinkage: 350 g.
    await record({ type: 'StockCounted', itemId: 'yirgacheffe', countedQuantity: 15850 });

    expect(await quantityOf('yirgacheffe')).toBe(15850);
    expect((await quantityOf('yirgacheffe'))! - predicted).toBe(-350);

    // The log is not rewritten: the disagreement stays visible in history.
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE stream_id = 'yirgacheffe'",
    );
    expect(rows[0]?.count).toBe('5');
  });

  it('omits streams that were never defined', async () => {
    await record({ type: 'StockReceived', itemId: 'ghost', quantity: 100 });
    expect(await quantityOf('ghost')).toBeUndefined();
  });
});
