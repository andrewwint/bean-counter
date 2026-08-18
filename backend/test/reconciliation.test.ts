import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import {
  getItemReconciliation,
  listReconciliation,
  type ItemReconciliation,
  type ReconciliationRow,
} from '../src/readmodel/reconciliation.ts';
import { quantityOf, record, resetDatabase } from './helpers.ts';

/**
 * Variance is the product, so these run against the real SQL in
 * migrations/005_reconciliation.sql — no mocks, no TypeScript restatement of
 * the fold.
 */

const app = createApp();

const define = (itemId: string, baseUnit: 'g' | 'ml' | 'each' = 'g') =>
  record({ type: 'ItemDefined', itemId, name: itemId, category: 'test', baseUnit });

const count = (itemId: string, countedQuantity: number) =>
  record({ type: 'StockCounted', itemId, countedQuantity });

const receive = (itemId: string, quantity: number) =>
  record({ type: 'StockReceived', itemId, quantity });

const deplete = (itemId: string, quantity: number, reason: 'sale' | 'waste' | 'sample' = 'sale') =>
  record({ type: 'StockDepleted', itemId, quantity, reason });

async function reconcile(itemId: string): Promise<ItemReconciliation> {
  const report = await getItemReconciliation(itemId);
  if (!report) throw new Error(`no reconciliation for ${itemId}`);
  return report;
}

beforeEach(resetDatabase);
afterAll(closePool);

describe('per-count variance', () => {
  it('reports shrinkage when the shelf holds less than the log predicted', async () => {
    await define('shrinkage');
    await count('shrinkage', 12000);
    await receive('shrinkage', 6000);
    await deplete('shrinkage', 1800);
    await count('shrinkage', 15850); // the log said 16200

    const { counts, totalVariance } = await reconcile('shrinkage');

    expect(counts).toHaveLength(2);
    expect(counts[1]).toMatchObject({
      countedQuantity: 15850,
      expectedQuantity: 16200,
      variance: -350,
      variancePct: -2.16, // -350 / 16200
      isOpeningBalance: false,
    });
    // The opening count is history, not a variance: the log had predicted
    // nothing, so there was nothing for the shelf to disagree with.
    expect(counts[0]).toMatchObject({
      countedQuantity: 12000,
      expectedQuantity: 0,
      variance: null,
      variancePct: null,
      isOpeningBalance: true,
    });
    // -350, not +11650. Scoring the opening balance would bury the real number.
    expect(totalVariance).toBe(-350);
  });

  it('reports overage when more is on the shelf than the log predicted', async () => {
    await define('overage');
    await count('overage', 4000);
    await deplete('overage', 500);
    await count('overage', 3900); // expected 3500 — an unrecorded delivery

    const { counts, totalVariance } = await reconcile('overage');

    expect(counts[1]).toMatchObject({
      expectedQuantity: 3500,
      variance: 400,
      variancePct: 11.43,
      isOpeningBalance: false,
    });
    expect(totalVariance).toBe(400);
  });

  it('reports zero variance when the count agrees with the log', async () => {
    await define('clean');
    await count('clean', 5000);
    await deplete('clean', 900);
    await count('clean', 4100);

    expect((await reconcile('clean')).counts[1]).toMatchObject({
      expectedQuantity: 4100,
      variance: 0,
      variancePct: 0,
    });
  });

  it('baselines each count off the PREVIOUS count, not off zero', async () => {
    // The case most likely to be wrong. If the second count folded from zero it
    // would expect 150 and report +950 of "overage" that never happened.
    await define('two-counts');
    await count('two-counts', 1000);
    await receive('two-counts', 200);
    await deplete('two-counts', 50);
    await count('two-counts', 1100);

    const { counts } = await reconcile('two-counts');

    expect(counts.map((c) => c.expectedQuantity)).toEqual([0, 1150]);
    expect(counts.map((c) => c.variance)).toEqual([null, -50]);
    expect(counts.map((c) => c.isOpeningBalance)).toEqual([true, false]);
  });

  it('ignores movement recorded after a count when scoring that count', async () => {
    await define('later');
    await count('later', 1000);
    await count('later', 1000); // same instant, nothing moved between them
    await receive('later', 9999); // must not leak backwards into count 2

    const { counts } = await reconcile('later');
    expect(counts[1]).toMatchObject({ expectedQuantity: 1000, variance: 0 });
  });

  it('treats a first count with no prior events as an opening balance', async () => {
    await define('first-count');
    await count('first-count', 800);

    const report = await reconcile('first-count');
    const [first] = report.counts;

    expect(first?.expectedQuantity).toBe(0);
    expect(first?.isOpeningBalance).toBe(true);
    expect(first?.variance).toBeNull();
    expect(first?.variancePct).toBeNull();
    // Explicitly not the tempting substitutes.
    expect(first?.variancePct).not.toBe(0);
    expect(Number.isFinite(first?.variancePct as number)).toBe(false);
    expect(report.totalVariance).toBe(0);
  });

  it('never emits Infinity or NaN when a scored count expected nothing', async () => {
    // Not an opening balance — the log did predict, and predicted zero. The
    // variance is real (50 g appeared); only the percentage has no denominator.
    await define('expected-nothing');
    await receive('expected-nothing', 100);
    await deplete('expected-nothing', 100);
    await count('expected-nothing', 50);

    const [scored] = (await reconcile('expected-nothing')).counts;
    expect(scored).toMatchObject({
      expectedQuantity: 0,
      variance: 50,
      variancePct: null,
      isOpeningBalance: false,
    });
    expect(Number.isFinite(scored?.variancePct as number)).toBe(false);
  });

  it('treats a counted quantity of zero as a real observation', async () => {
    // "We're out of oat milk" — slice-1 resolved ambiguity #2.
    await define('wiped', 'ml');
    await receive('wiped', 5000);
    await count('wiped', 0); // the log predicted 5000; the shelf was bare
    await receive('wiped', 2000);

    const report = await reconcile('wiped');

    // Movement came first, so this is a genuine (catastrophic) variance, NOT an
    // opening balance. The discriminator is "was anything known before this
    // count?", never "did the expected value work out to zero?".
    expect(report.counts[0]).toMatchObject({
      countedQuantity: 0,
      expectedQuantity: 5000,
      variance: -5000,
      variancePct: -100,
      isOpeningBalance: false,
    });
    expect(report.sinceLastCount).toEqual({
      received: 2000,
      depleted: { sale: 0, waste: 0, sample: 0 },
      expectedQuantity: 2000,
    });
    expect(await quantityOf('wiped')).toBe(2000);
  });

  it('keeps variance an exact integer at large magnitudes', async () => {
    await define('big');
    await count('big', 9007199254740991);
    await deplete('big', 1);
    await count('big', 9007199254740000);

    const { counts } = await reconcile('big');
    expect(counts[0]?.isOpeningBalance).toBe(true);
    expect(counts[1]?.expectedQuantity).toBe(9007199254740990);
    expect(counts[1]?.variance).toBe(-990);
    expect(Number.isInteger(counts[1]?.variance)).toBe(true);
  });
});

describe('sinceLastCount', () => {
  it('breaks movement down by reason and folds onto the last count', async () => {
    await define('tail');
    await count('tail', 10000);
    await receive('tail', 2000);
    await deplete('tail', 300, 'sale');
    await deplete('tail', 120, 'waste');
    await deplete('tail', 80, 'sample');

    const report = await reconcile('tail');
    expect(report.sinceLastCount).toEqual({
      received: 2000,
      depleted: { sale: 300, waste: 120, sample: 80 },
      expectedQuantity: 11500,
    });
    // The contract's invariant: two different folds, one number.
    expect(report.sinceLastCount.expectedQuantity).toBe(await quantityOf('tail'));
  });

  it('folds from zero for an item that has never been counted', async () => {
    await define('never-counted');
    await receive('never-counted', 12000);
    await deplete('never-counted', 1800, 'sale');
    await deplete('never-counted', 400, 'waste');

    const report = await reconcile('never-counted');

    expect(report.counts).toEqual([]);
    expect(report.totalVariance).toBe(0);
    expect(report.sinceLastCount).toEqual({
      received: 12000,
      depleted: { sale: 1800, waste: 400, sample: 0 },
      expectedQuantity: 9800,
    });
    expect(report.sinceLastCount.expectedQuantity).toBe(await quantityOf('never-counted'));
  });

  it('is all zeroes for an item with nothing but a definition', async () => {
    await define('bare');
    const report = await reconcile('bare');

    expect(report.counts).toEqual([]);
    expect(report.sinceLastCount).toEqual({
      received: 0,
      depleted: { sale: 0, waste: 0, sample: 0 },
      expectedQuantity: 0,
    });
    expect(report.sinceLastCount.expectedQuantity).toBe(await quantityOf('bare'));
  });
});

describe('GET /api/items/:itemId/reconciliation', () => {
  it('returns 200 with the contract shape', async () => {
    await define('bean-yirgacheffe');
    await count('bean-yirgacheffe', 16000);
    await deplete('bean-yirgacheffe', 150, 'waste');
    await count('bean-yirgacheffe', 15850);

    const response = await app.request('/api/items/bean-yirgacheffe/reconciliation');
    expect(response.status).toBe(200);

    const body = (await response.json()) as ItemReconciliation;
    expect(body.itemId).toBe('bean-yirgacheffe');
    expect(body.name).toBe('bean-yirgacheffe');
    expect(body.baseUnit).toBe('g');
    expect(Object.keys(body.counts[1] ?? {}).sort()).toEqual([
      'countedQuantity',
      'expectedQuantity',
      'isOpeningBalance',
      'occurredAt',
      'sequence',
      'variance',
      'variancePct',
    ]);
    expect(body.counts[1]?.variance).toBe(0);
    expect(new Date(body.counts[1]?.occurredAt ?? '').toISOString()).toBe(
      body.counts[1]?.occurredAt,
    );
  });

  it('returns 200, not 404, for a defined item that was never counted', async () => {
    await define('uncounted');
    await receive('uncounted', 300);

    const response = await app.request('/api/items/uncounted/reconciliation');
    expect(response.status).toBe(200);

    const body = (await response.json()) as ItemReconciliation;
    expect(body.counts).toEqual([]);
    expect(body.totalVariance).toBe(0);
    expect(body.sinceLastCount.expectedQuantity).toBe(300);
  });

  it('404s an item that was never defined, in the contract error shape', async () => {
    // Movement without a definition is deliberately invisible (slice-1 #4).
    await receive('ghost', 100);

    const response = await app.request('/api/items/ghost/reconciliation');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('ghost');
  });

  it('lists counts chronologically', async () => {
    await define('ordered');
    await count('ordered', 100);
    await count('ordered', 200);
    await count('ordered', 300);

    const { counts } = await reconcile('ordered');
    expect(counts.map((c) => c.countedQuantity)).toEqual([100, 200, 300]);
    expect(counts.map((c) => c.sequence)).toEqual(
      [...counts].map((c) => c.sequence).sort((a, b) => a - b),
    );
  });
});

describe('GET /api/reconciliation', () => {
  beforeEach(async () => {
    // Each item opens with a count (an opening balance, never scored), then is
    // counted a second time against a log that did predict something.

    // -100 of 9000 expected = -1.11%. Big number, small problem.
    await define('big-item');
    await count('big-item', 10000);
    await deplete('big-item', 1000);
    await count('big-item', 8900);

    // -9 of 90 expected = -10%. Small number, big problem.
    await define('small-item');
    await count('small-item', 100);
    await deplete('small-item', 10);
    await count('small-item', 81);

    // +300 of 1200 expected = +25%: a delivery nobody wrote down.
    await define('over-item');
    await count('over-item', 1000);
    await receive('over-item', 200);
    await count('over-item', 1500);

    // Counted once, with an empty log behind it: nothing scorable at all.
    await define('opening-only');
    await count('opening-only', 500);

    await define('uncounted');
    await receive('uncounted', 300);
  });

  it('ranks by percentage, not by raw variance in incommensurable units', async () => {
    const response = await app.request('/api/reconciliation');
    expect(response.status).toBe(200);
    const rows = (await response.json()) as ReconciliationRow[];

    expect(rows.map((r) => r.itemId)).toEqual([
      'small-item', // -10%
      'big-item', //  -1.11%
      'over-item', // +25%
      'opening-only', // nothing scorable
      'uncounted', // never counted
    ]);
    expect(rows.map((r) => r.totalVariancePct)).toEqual([-10, -1.11, 25, null, null]);

    // Ranking by the raw base-unit number would have put big-item (-100) above
    // small-item (-9) — comparing grams against each with a straight face.
    expect(rows.map((r) => r.totalVariance)).toEqual([-9, -100, 300, 0, 0]);
  });

  it('excludes opening balances from every total it reports', async () => {
    const rows = await listReconciliation();
    const byId = Object.fromEntries(rows.map((r) => [r.itemId, r.totalVariance]));

    // 10000 and 100 and 1000 were opening balances; none of them are in here.
    expect(byId).toEqual({
      'big-item': -100,
      'small-item': -9,
      'over-item': 300,
      'opening-only': 0,
      uncounted: 0,
    });
  });

  it('sorts "nothing scorable" below every item that has a real percentage', async () => {
    const rows = await listReconciliation();
    const firstNull = rows.findIndex((r) => r.totalVariancePct === null);

    expect(firstNull).toBe(3);
    expect(rows.slice(firstNull).every((r) => r.totalVariancePct === null)).toBe(true);
    // "reconciles exactly" would have been a 0 here, not a null.
    expect(rows.at(-1)?.totalVariancePct).not.toBe(0);
  });

  it('reports a never-counted item rather than filtering it out', async () => {
    const rows = await listReconciliation();

    const uncounted = rows.find((r) => r.itemId === 'uncounted');
    // Present, with every key populated — the UI keys "never counted" off
    // countsRecorded === 0, so that field must be accurate at zero.
    expect(uncounted).toEqual({
      itemId: 'uncounted',
      name: 'uncounted',
      category: 'test',
      baseUnit: 'g',
      totalVariance: 0,
      totalVariancePct: null,
      lastCountAt: null,
      countsRecorded: 0,
    });
    // Explicitly a null, not an omitted key and not a stand-in timestamp.
    expect(Object.keys(uncounted ?? {})).toContain('lastCountAt');
    expect(uncounted?.lastCountAt).toBeNull();
  });

  it('serialises lastCountAt as null over HTTP too', async () => {
    const response = await app.request('/api/reconciliation');
    const rows = (await response.json()) as ReconciliationRow[];
    const uncounted = rows.find((r) => r.itemId === 'uncounted');

    expect(uncounted).toBeDefined();
    expect(uncounted).toHaveProperty('lastCountAt', null);
    expect(uncounted?.countsRecorded).toBe(0);
    expect(uncounted?.totalVariance).toBe(0);
  });

  it('counts every StockCounted event in countsRecorded, opening balance included', async () => {
    const rows = await listReconciliation();

    const big = rows.find((r) => r.itemId === 'big-item');
    expect(big?.countsRecorded).toBe(2);
    expect(big?.lastCountAt).not.toBeNull();
    expect(new Date(big?.lastCountAt ?? '').toISOString()).toBe(big?.lastCountAt);

    // Counted once, and that once was an opening balance: still 1, not 0. It
    // is the count of events, not the count of scored variances.
    const openingOnly = rows.find((r) => r.itemId === 'opening-only');
    expect(openingOnly?.countsRecorded).toBe(1);
    expect(openingOnly?.lastCountAt).not.toBeNull();
  });

  it('omits streams that were never defined', async () => {
    await receive('ghost', 100);
    await count('ghost', 50);

    const rows = await listReconciliation();
    expect(rows.map((r) => r.itemId)).not.toContain('ghost');
  });
});
