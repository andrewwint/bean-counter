import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import {
  getItemReconciliation,
  listReconciliation,
  type ItemReconciliation,
  type ReconciliationRow,
} from '../src/readmodel/reconciliation.ts';
import { seed } from '../src/seed.ts';
import { resetDatabase } from './helpers.ts';

/**
 * The seeded week, with the numbers the seed's own header table promises. If
 * these move, either the seed changed or the variance calculation is wrong —
 * both are worth failing over.
 */

const app = createApp();

/**
 * GROUND TRUTH for the seeded week — Monday's count against what the log
 * predicted. Corroborated three ways: hand-written SQL straight over `events`,
 * the analytics lane folding a Parquet snapshot in Python, and the seed's own
 * header table. If this test goes red, the number the product exists to report
 * has moved; fix the code or change the seed deliberately, never this table.
 *
 * Every real variance in the seed is negative or zero. There is no overage
 * anywhere: a positive number here means a bug, not a finding.
 */
const MONDAY = {
  'bean-yirgacheffe': { opening: 12000, expected: 16200, counted: 15850, variance: -350, pct: -2.16 },
  'bean-huila': { opening: 8000, expected: 6400, counted: 6250, variance: -150, pct: -2.34 },
  'bean-sumatra': { opening: 5000, expected: 4100, counted: 4100, variance: 0, pct: 0 },
  'milk-whole': { opening: 24000, expected: 15000, counted: 14100, variance: -900, pct: -6 },
  'milk-oat': { opening: 12000, expected: 20500, counted: 20500, variance: 0, pct: 0 },
  'cup-12oz': { opening: 800, expected: 1657, counted: 1610, variance: -47, pct: -2.84 },
  'lid-12oz': { opening: 800, expected: 657, counted: 657, variance: 0, pct: 0 },
} as const;

beforeAll(async () => {
  await resetDatabase();
  await seed(pool, () => {});
});
afterAll(closePool);

describe('the seeded week', () => {
  it('surfaces Monday’s shrinkage for every item', async () => {
    for (const [itemId, expected] of Object.entries(MONDAY)) {
      const report = await getItemReconciliation(itemId);
      const [opening, monday] = report?.counts ?? [];

      expect(report?.counts, itemId).toHaveLength(2);

      // Week one's opening count: no log behind it, so it is a balance, not a
      // variance, and it must not reach the total.
      expect(opening, itemId).toMatchObject({
        occurredAt: '2026-08-03T14:05:00.000Z',
        countedQuantity: expected.opening,
        expectedQuantity: 0,
        variance: null,
        variancePct: null,
        isOpeningBalance: true,
      });

      expect(monday, itemId).toMatchObject({
        occurredAt: '2026-08-10T14:05:00.000Z',
        countedQuantity: expected.counted,
        expectedQuantity: expected.expected,
        variance: expected.variance,
        variancePct: expected.pct,
        isOpeningBalance: false,
      });

      // The whole item total is Monday's gap and nothing else.
      expect(report?.totalVariance, itemId).toBe(expected.variance);
      expect(expected.variance, itemId).toBeLessThanOrEqual(0);
    }
  });

  it('reports the shop-wide totals the seed was built to produce', async () => {
    const rows = await listReconciliation();
    const byId = Object.fromEntries(rows.map((r) => [r.itemId, r.totalVariance]));

    expect(byId).toEqual({
      'milk-whole': -900,
      'bean-yirgacheffe': -350,
      'bean-huila': -150,
      'cup-12oz': -47,
      'lid-12oz': 0,
      'milk-oat': 0,
      'bean-sumatra': 0,
    });
    // No item in the seeded week is over. A positive total is a bug.
    expect(rows.every((r) => r.totalVariance <= 0)).toBe(true);

    // A genuine zero, from an item that WAS counted — not the null-ish zero of
    // an item nobody has looked at.
    for (const itemId of ['lid-12oz', 'milk-oat', 'bean-sumatra']) {
      const row = rows.find((r) => r.itemId === itemId);
      expect(row?.countsRecorded, itemId).toBe(2);
      expect(row?.totalVariancePct, itemId).toBe(0);
      expect(row?.lastCountAt, itemId).toBe('2026-08-10T14:05:00.000Z');
    }
  });

  it('gives the full Yirgacheffe report', async () => {
    const response = await app.request('/api/items/bean-yirgacheffe/reconciliation');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ItemReconciliation;

    expect(body.itemId).toBe('bean-yirgacheffe');
    expect(body.name).toBe('Yirgacheffe');
    expect(body.baseUnit).toBe('g');

    // Monday of week one: an opening count with no history behind it. Shown,
    // but not scored — booking it would report +12 kg of overage that never
    // happened and hide the 350 g that did.
    expect(body.counts[0]).toMatchObject({
      occurredAt: '2026-08-03T14:05:00.000Z',
      countedQuantity: 12000,
      expectedQuantity: 0,
      variance: null,
      variancePct: null,
      isOpeningBalance: true,
    });
    // Monday of week two: 12000 opening + 6000 delivered - 1800 sold = 16200
    // predicted; 15850 on the shelf. 350 g of beans are unaccounted for.
    expect(body.counts[1]).toMatchObject({
      sequence: 31,
      countedQuantity: 15850,
      expectedQuantity: 16200,
      variance: -350,
      variancePct: -2.16,
      isOpeningBalance: false,
    });
    expect(body.counts).toHaveLength(2);
    expect(body.totalVariance).toBe(-350);
    expect(body.sinceLastCount).toEqual({
      received: 0,
      depleted: { sale: 0, waste: 0, sample: 0 },
      expectedQuantity: 15850,
    });
  });

  it('folds the deliveries and sales that landed after Monday’s count', async () => {
    // A 5000 g delivery arrived after Huila was counted at 6250.
    const huila = await getItemReconciliation('bean-huila');
    expect(huila?.sinceLastCount).toEqual({
      received: 5000,
      depleted: { sale: 0, waste: 0, sample: 0 },
      expectedQuantity: 11250,
    });

    // 1200 ml of whole milk sold after it was counted at 14100.
    const milk = await getItemReconciliation('milk-whole');
    expect(milk?.sinceLastCount).toEqual({
      received: 0,
      depleted: { sale: 1200, waste: 0, sample: 0 },
      expectedQuantity: 12900,
    });
  });

  it('counts the Saturday waste as a depletion, not as shrinkage', async () => {
    // 400 g of Huila was dumped and recorded. Recorded waste is predicted by
    // the log, so it shows up in `expectedQuantity`, not in the variance:
    // 8000 - 1200 sold - 400 wasted = 6400 expected, 6250 found, -150 missing.
    const huila = await getItemReconciliation('bean-huila');
    expect(huila?.counts[1]).toMatchObject({ expectedQuantity: 6400, variance: -150 });
  });

  it('agrees with item_stock for every seeded item (the contract invariant)', async () => {
    const { rows } = await pool.query<{ item_id: string; quantity: number }>(
      'SELECT item_id, quantity FROM item_stock ORDER BY item_id',
    );
    expect(rows).toHaveLength(7);

    for (const { item_id, quantity } of rows) {
      const report = await getItemReconciliation(item_id);
      // Two derivations of one number over one log: epoch windows here,
      // DISTINCT ON + delta join in item_stock. They must not disagree.
      expect(report?.sinceLastCount.expectedQuantity, item_id).toBe(quantity);
    }
  });

  it('ranks the shop-wide report by percentage, worst first', async () => {
    const response = await app.request('/api/reconciliation');
    const rows = (await response.json()) as ReconciliationRow[];

    expect(rows).toHaveLength(7);
    // Whole milk is the worst offender at -6%, even though the cups are only
    // -47 units: -900 ml and -47 each are not comparable numbers, -6% and
    // -2.84% are.
    expect(rows.map((r) => r.itemId)).toEqual([
      'milk-whole', //       -6%
      'cup-12oz', //         -2.84%
      'bean-huila', //       -2.34%
      'bean-yirgacheffe', // -2.16%
      'lid-12oz', //          0%
      'milk-oat', //          0%
      'bean-sumatra', //      0%
    ]);
    expect(rows.map((r) => r.totalVariancePct)).toEqual([-6, -2.84, -2.34, -2.16, 0, 0, 0]);

    // Every seeded item was counted twice, on the same two mornings.
    expect(rows.every((r) => r.countsRecorded === 2)).toBe(true);
    expect(rows.every((r) => r.lastCountAt === '2026-08-10T14:05:00.000Z')).toBe(true);
  });

  it('matches the read model when read through the HTTP layer', async () => {
    const direct = await listReconciliation();
    const response = await app.request('/api/reconciliation');
    expect(await response.json()).toEqual(direct);
  });
});
