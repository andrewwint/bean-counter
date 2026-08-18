import type { Pool, PoolClient } from 'pg';
import { pool } from '../db.ts';

/**
 * Reconciliation: the gap between what the log predicted and what the shelf
 * held. The arithmetic lives in SQL (migrations/005_reconciliation.sql); this
 * module is the shape of the answer, not a second copy of the fold.
 *
 * Quantities stay integers in the item's base unit. `variancePct` is the only
 * float that leaves here.
 */

/** One physical count, and how far the log was off at that moment. */
export interface CountVariance {
  sequence: number;
  occurredAt: string;
  countedQuantity: number;
  expectedQuantity: number;
  /**
   * counted - expected. Negative = shrinkage, positive = overage.
   * `null` for an opening balance — the log predicted nothing, so there is no
   * variance, which is a different fact from a variance of 0.
   */
  variance: number | null;
  /** null when expectedQuantity is 0 — there is no denominator. */
  variancePct: number | null;
  /**
   * The item's first count, taken with no movement recorded before it. Shown in
   * the detail view because it is real history, but never scored.
   */
  isOpeningBalance: boolean;
}

export interface SinceLastCount {
  received: number;
  depleted: { sale: number; waste: number; sample: number };
  /** Must equal item_stock.quantity — see the contract's invariant. */
  expectedQuantity: number;
}

export interface ItemReconciliation {
  itemId: string;
  name: string;
  baseUnit: string;
  counts: CountVariance[];
  /** Sum over the SCORED counts; opening balances contribute nothing. */
  totalVariance: number;
  sinceLastCount: SinceLastCount;
}

export interface ReconciliationRow {
  itemId: string;
  name: string;
  category: string;
  baseUnit: string;
  /** In this item's base unit — comparable across items only as a percentage. */
  totalVariance: number;
  /**
   * The ranking key: total variance over total expected across this item's
   * scored counts. Unit-free, so `-6` ml of milk and `-2.84` each of cups can
   * be ranked against each other. `null` when there is nothing scorable.
   */
  totalVariancePct: number | null;
  lastCountAt: string | null;
  countsRecorded: number;
}

/**
 * Variance as a percentage of what was expected.
 *
 * `null` — never `Infinity`, `NaN`, or a substituted 0 — when nothing was
 * expected: a first count on an empty log has no baseline to be off by.
 * Rounded to two decimals to match the contract's example; the exact integers
 * (`variance`, `expectedQuantity`) are both in the response, so nothing is lost.
 */
function variancePct(variance: number, expectedQuantity: number): number | null {
  if (expectedQuantity === 0) return null;
  const pct = Math.round((variance / expectedQuantity) * 10_000) / 100;
  // A vanishingly small negative rounds to -0, which serialises as 0 anyway but
  // formats as "-0.00%" on screen. Hand back a plain zero.
  return pct === 0 ? 0 : pct;
}

/**
 * One item's reconciliation, or `null` when the item was never defined (the
 * route turns that into a 404). An item that exists but has never been counted
 * is NOT null: it gets `counts: []` and a `sinceLastCount` folded from 0.
 *
 * The three reads run in one REPEATABLE READ snapshot. They are separate
 * queries but they describe one moment: an append landing between them could
 * otherwise produce a response whose counts and whose `sinceLastCount`
 * disagree, breaking exactly the invariant this endpoint exists to expose.
 */
export async function getItemReconciliation(
  itemId: string,
  executor: Pool | PoolClient = pool,
): Promise<ItemReconciliation | null> {
  const client = 'release' in executor ? executor : await executor.connect();
  const borrowed = client !== executor;

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await readItemReconciliation(client, itemId);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (borrowed) client.release();
  }
}

async function readItemReconciliation(
  client: PoolClient,
  itemId: string,
): Promise<ItemReconciliation | null> {
  // Identity comes from the existing read model: appearing in `item_stock` is
  // precisely "has an ItemDefined" (slice-1 resolved ambiguity #4).
  const identity = await client.query<{ name: string; base_unit: string }>(
    'SELECT name, base_unit FROM item_stock WHERE item_id = $1',
    [itemId],
  );
  const item = identity.rows[0];
  if (!item) return null;

  const counts = await client.query<{
    sequence: number;
    occurred_at: Date;
    counted_quantity: number;
    expected_quantity: number;
    variance: number | null;
    is_opening_balance: boolean;
  }>(
    `SELECT sequence, occurred_at, counted_quantity, expected_quantity, variance,
            is_opening_balance
       FROM item_count_variance
      WHERE item_id = $1
      ORDER BY sequence`,
    [itemId],
  );

  const since = await client.query<{
    received: number;
    depleted_sale: number;
    depleted_waste: number;
    depleted_sample: number;
    expected_quantity: number;
  }>(
    `SELECT received, depleted_sale, depleted_waste, depleted_sample, expected_quantity
       FROM item_since_last_count
      WHERE item_id = $1`,
    [itemId],
  );
  const tail = since.rows[0];

  return {
    itemId,
    name: item.name,
    baseUnit: item.base_unit,
    counts: counts.rows.map((r) => ({
      sequence: r.sequence,
      occurredAt: r.occurred_at.toISOString(),
      countedQuantity: r.counted_quantity,
      expectedQuantity: r.expected_quantity,
      variance: r.variance,
      variancePct: r.variance === null ? null : variancePct(r.variance, r.expected_quantity),
      isOpeningBalance: r.is_opening_balance,
    })),
    // Opening balances carry a null variance and drop out of the total. The
    // seeded week is why this matters: scored, the shop reads as +11650 g of
    // phantom overage; unscored, it reads as -350 g of missing beans — which is
    // the number that is actually true.
    totalVariance: counts.rows.reduce((sum, r) => sum + (r.variance ?? 0), 0),
    sinceLastCount: {
      // No row at all means the item has an ItemDefined and nothing else:
      // nothing received, nothing depleted, and a fold from 0.
      received: tail?.received ?? 0,
      depleted: {
        sale: tail?.depleted_sale ?? 0,
        waste: tail?.depleted_waste ?? 0,
        sample: tail?.depleted_sample ?? 0,
      },
      expectedQuantity: tail?.expected_quantity ?? 0,
    },
  };
}

/**
 * The shop-wide shrinkage report, worst first.
 *
 * Ranked by PERCENTAGE, not by raw variance. `totalVariance` is in the item's
 * own base unit, so -900 ml of milk, -350 g of beans and -47 cups are not
 * comparable numbers; ranking them against each other by magnitude is
 * arithmetic without meaning. `totalVariancePct` — total variance over total
 * expected across the item's scored counts — is unit-free, so it ranks.
 *
 * Opening balances are excluded from both, and an item with nothing scorable
 * (never counted, or only an opening balance) sorts LAST with a null
 * percentage. "No data" is not "reconciles exactly", and a manager reading top
 * to bottom must not find the two adjacent. Every defined item is reported;
 * none is filtered out. `countsRecorded` is the field that tells the states
 * apart, and `lastCountAt` is null rather than a stand-in timestamp.
 */
export async function listReconciliation(
  executor: Pool | PoolClient = pool,
): Promise<ReconciliationRow[]> {
  const { rows } = await executor.query<{
    item_id: string;
    name: string;
    category: string;
    base_unit: string;
    total_variance: number;
    scored_expected: number | null;
    last_count_at: Date | null;
    counts_recorded: number;
  }>(
    `WITH scored AS (
       SELECT
         s.item_id,
         s.name,
         s.category,
         s.base_unit,
         -- sum() skips NULLs, so opening balances drop out of the total on
         -- their own — there is no filter here to forget to write.
         coalesce(sum(v.variance), 0)::bigint AS total_variance,
         -- The denominator, over scored counts only. The FILTER is currently
         -- redundant — an opening balance has no prior events, so its
         -- expected_quantity is always 0 — but it states the intent, and it
         -- keeps this sum right if that definition is ever widened.
         (sum(v.expected_quantity) FILTER (WHERE NOT v.is_opening_balance))::bigint
           AS scored_expected,
         max(v.occurred_at)                   AS last_count_at,
         count(v.sequence)::bigint            AS counts_recorded
       FROM item_stock s
       LEFT JOIN item_count_variance v ON v.item_id = s.item_id
       GROUP BY s.item_id, s.name, s.category, s.base_unit
     )
     SELECT *
       FROM scored
      ORDER BY
        -- Ranked on the exact ratio, not the rounded percentage we emit, so
        -- two rows that display the same figure still rank deterministically.
        -- A non-positive denominator is no denominator: those rows sort last.
        CASE WHEN scored_expected > 0
             THEN total_variance::numeric / scored_expected END ASC NULLS LAST,
        name ASC`,
  );

  return rows.map((r) => ({
    itemId: r.item_id,
    name: r.name,
    category: r.category,
    baseUnit: r.base_unit,
    totalVariance: r.total_variance,
    // The same two integers the ORDER BY used, guarded the same way, so the
    // emitted key never disagrees with the rank it produced.
    totalVariancePct:
      r.scored_expected !== null && r.scored_expected > 0
        ? variancePct(r.total_variance, r.scored_expected)
        : null,
    lastCountAt: r.last_count_at ? r.last_count_at.toISOString() : null,
    countsRecorded: r.counts_recorded,
  }));
}
