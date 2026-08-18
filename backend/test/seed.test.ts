import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { quantityOf, resetDatabase } from './helpers.ts';

beforeEach(resetDatabase);
afterAll(closePool);

describe('seed', () => {
  it('is idempotent and leaves the documented shrinkage gap on the board', async () => {
    const first = await seed(pool, () => {});
    expect(first).toBeGreaterThan(0);

    const second = await seed(pool, () => {});
    expect(second).toBe(0);

    const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM events');
    expect(Number(rows[0]?.count)).toBe(first);

    // Monday's count (15850) is the baseline; nothing moved after it.
    expect(await quantityOf('bean-yirgacheffe')).toBe(15850);
    // Counted 6250, then a 5000 g delivery landed after the count.
    expect(await quantityOf('bean-huila')).toBe(11250);
    // Counted 14100, then 1200 ml sold.
    expect(await quantityOf('milk-whole')).toBe(12900);
  });

  it('records a count that is short of what the log predicted', async () => {
    await seed(pool, () => {});

    // Fold the log up to (but not including) Monday's count for the cups...
    const { rows } = await pool.query<{ predicted: number }>(
      `WITH monday AS (
         SELECT max(sequence) AS seq
           FROM events
          WHERE stream_id = 'cup-12oz' AND event_type = 'StockCounted'
       ),
       opening AS (
         SELECT sequence AS seq, (payload ->> 'countedQuantity')::bigint AS qty
           FROM events
          WHERE stream_id = 'cup-12oz'
            AND event_type = 'StockCounted'
            AND sequence < (SELECT seq FROM monday)
          ORDER BY sequence DESC
          LIMIT 1
       )
       SELECT ((SELECT qty FROM opening) + coalesce(sum(
                 CASE e.event_type
                   WHEN 'StockReceived' THEN  (e.payload ->> 'quantity')::bigint
                   WHEN 'StockDepleted' THEN -(e.payload ->> 'quantity')::bigint
                   ELSE 0
                 END), 0))::bigint AS predicted
         FROM events e
        WHERE e.stream_id = 'cup-12oz'
          AND e.sequence > (SELECT seq FROM opening)
          AND e.sequence < (SELECT seq FROM monday)`,
    );

    expect(rows[0]?.predicted).toBe(1657);
    // The shelf held 1610: 47 cups unaccounted for. The count wins.
    expect(await quantityOf('cup-12oz')).toBe(1610);
  });
});
