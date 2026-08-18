import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { closePool, pool } from './db.ts';
import { validateEvent } from './events/schema.ts';
import { refreshItemStock } from './readmodel/stock.ts';

/**
 * Seed: one realistic week at the counter.
 *
 * Idempotent. Each seeded event gets a deterministic id derived from its
 * position in this file, and the insert is `ON CONFLICT (event_id) DO NOTHING`.
 * Re-running `npm run seed` — or re-running it after a half-finished run —
 * adds nothing and changes nothing. Note this is the ONLY place that needs the
 * conflict clause; the log itself stays append-only either way.
 *
 * THE POINT OF THIS DATA — the shrinkage gap.
 *
 * The week ends with a Monday physical count that comes up SHORT of what the
 * log predicts. That is not a bug in the seed and it is not a bug in the fold:
 * it is the thing this whole application exists to make visible. Beans get
 * over-dosed, milk gets spilled, cups walk off. The log says one number, the
 * shelf says another, and the count wins:
 *
 *   item              predicted by log   Monday count   gap
 *   Yirgacheffe            16200 g          15850 g     -350 g
 *   Huila                   6400 g           6250 g     -150 g
 *   Sumatra                 4100 g           4100 g        0
 *   Whole milk             15000 ml         14100 ml     -900 ml
 *   Oat milk               20500 ml         20500 ml        0
 *   12oz cups               1657 each        1610 each    -47
 *   12oz lids                657 each         657 each       0
 *
 * After the count, two more movements land (a Monday bean delivery and a
 * lunchtime milk sale) so the board on first boot is genuinely
 * "last count + later deltas", not just the count.
 */

type SeedEvent = Record<string, unknown> & { type: string; occurredAt: string };

const ITEMS: SeedEvent[] = [
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'bean-yirgacheffe', name: 'Yirgacheffe', category: 'beans', baseUnit: 'g' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'bean-huila', name: 'Huila', category: 'beans', baseUnit: 'g' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'bean-sumatra', name: 'Sumatra Mandheling', category: 'beans', baseUnit: 'g' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'milk-whole', name: 'Whole Milk', category: 'milk', baseUnit: 'ml' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'milk-oat', name: 'Oat Milk', category: 'milk', baseUnit: 'ml' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'cup-12oz', name: '12oz Cup', category: 'packaging', baseUnit: 'each' },
  { type: 'ItemDefined', occurredAt: '2026-08-03T14:00:00.000Z', itemId: 'lid-12oz', name: '12oz Lid', category: 'packaging', baseUnit: 'each' },
];

// Monday morning: the opening count. Every item starts from a physical number.
const OPENING_COUNT: SeedEvent[] = [
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'bean-yirgacheffe', countedQuantity: 12000 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'bean-huila', countedQuantity: 8000 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'bean-sumatra', countedQuantity: 5000 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'milk-whole', countedQuantity: 24000 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'milk-oat', countedQuantity: 12000 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'cup-12oz', countedQuantity: 800 },
  { type: 'StockCounted', occurredAt: '2026-08-03T14:05:00.000Z', itemId: 'lid-12oz', countedQuantity: 800 },
];

// Wednesday: the roaster and the dry-goods delivery.
const MIDWEEK_DELIVERY: SeedEvent[] = [
  { type: 'StockReceived', occurredAt: '2026-08-05T13:20:00.000Z', itemId: 'bean-yirgacheffe', quantity: 6000, supplier: 'Ferry Building Roasters', lotId: 'LOT-2026-31' },
  { type: 'StockReceived', occurredAt: '2026-08-05T13:20:00.000Z', itemId: 'milk-oat', quantity: 12000, supplier: 'Bay Provisions' },
  { type: 'StockReceived', occurredAt: '2026-08-05T13:20:00.000Z', itemId: 'cup-12oz', quantity: 1000, supplier: 'Bay Provisions', lotId: 'PKG-8841' },
];

// Saturday: the busy one. Sales are batched by rush, the way a barista would
// actually record them — nobody types an event per latte.
const SATURDAY: SeedEvent[] = [
  { type: 'StockDepleted', occurredAt: '2026-08-08T18:00:00.000Z', itemId: 'bean-yirgacheffe', quantity: 1800, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T18:00:00.000Z', itemId: 'milk-whole', quantity: 6000, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T18:00:00.000Z', itemId: 'cup-12oz', quantity: 60, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T18:00:00.000Z', itemId: 'lid-12oz', quantity: 60, reason: 'sale' },

  { type: 'StockDepleted', occurredAt: '2026-08-08T20:30:00.000Z', itemId: 'bean-huila', quantity: 1200, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T20:30:00.000Z', itemId: 'milk-oat', quantity: 3500, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T20:30:00.000Z', itemId: 'cup-12oz', quantity: 45, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T20:30:00.000Z', itemId: 'lid-12oz', quantity: 45, reason: 'sale' },

  { type: 'StockDepleted', occurredAt: '2026-08-08T22:15:00.000Z', itemId: 'bean-sumatra', quantity: 900, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T22:15:00.000Z', itemId: 'milk-whole', quantity: 3000, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T22:15:00.000Z', itemId: 'cup-12oz', quantity: 38, reason: 'sale' },
  { type: 'StockDepleted', occurredAt: '2026-08-08T22:15:00.000Z', itemId: 'lid-12oz', quantity: 38, reason: 'sale' },

  // Close: a hopper of Huila went stale and was dumped. Waste is recorded as a
  // depletion with reason 'waste' so it never hides inside "sales".
  { type: 'StockDepleted', occurredAt: '2026-08-08T23:40:00.000Z', itemId: 'bean-huila', quantity: 400, reason: 'waste' },
];

// Monday: the physical count. It disagrees with the log — see the table above.
// The count is an absolute reset: from here the fold starts again from these
// numbers and applies only what happens afterwards.
const MONDAY_COUNT: SeedEvent[] = [
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'bean-yirgacheffe', countedQuantity: 15850 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'bean-huila', countedQuantity: 6250 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'bean-sumatra', countedQuantity: 4100 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'milk-whole', countedQuantity: 14100 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'milk-oat', countedQuantity: 20500 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'cup-12oz', countedQuantity: 1610 },
  { type: 'StockCounted', occurredAt: '2026-08-10T14:05:00.000Z', itemId: 'lid-12oz', countedQuantity: 657 },
];

// After the count — proves on first boot that later deltas still apply on top
// of the new baseline.
const AFTER_THE_COUNT: SeedEvent[] = [
  { type: 'StockReceived', occurredAt: '2026-08-10T16:00:00.000Z', itemId: 'bean-huila', quantity: 5000, supplier: 'Ferry Building Roasters', lotId: 'LOT-2026-32' },
  { type: 'StockDepleted', occurredAt: '2026-08-10T19:30:00.000Z', itemId: 'milk-whole', quantity: 1200, reason: 'sale' },
];

const SEED_EVENTS: SeedEvent[] = [
  ...ITEMS,
  ...OPENING_COUNT,
  ...MIDWEEK_DELIVERY,
  ...SATURDAY,
  ...MONDAY_COUNT,
  ...AFTER_THE_COUNT,
];

/** Deterministic UUIDv5 (namespace + name -> sha1) so seeding is idempotent. */
const SEED_NAMESPACE = '6f9619ff-8b86-d011-b42d-00c04fc964ff';

function uuidV5(name: string): string {
  const namespaceBytes = Buffer.from(SEED_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(name).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function seed(
  executor: Pool | PoolClient = pool,
  log: (message: string) => void = console.log,
): Promise<number> {
  let inserted = 0;

  for (const [index, raw] of SEED_EVENTS.entries()) {
    // Same validation the HTTP boundary uses — seed data is held to exactly the
    // rules real history is held to, so the log stays uniformly valid.
    const event = validateEvent(raw);

    const { rowCount } = await executor.query(
      `INSERT INTO events (event_id, stream_id, event_type, event_version, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        uuidV5(`seed:${index}:${event.type}:${event.streamId}`),
        event.streamId,
        event.type,
        event.eventVersion,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    inserted += rowCount ?? 0;
  }

  await refreshItemStock(executor);
  log(
    inserted === 0
      ? `seed: already present (${SEED_EVENTS.length} events), nothing to do`
      : `seed: inserted ${inserted} of ${SEED_EVENTS.length} events`,
  );
  return inserted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await seed();
  } finally {
    await closePool();
  }
}
