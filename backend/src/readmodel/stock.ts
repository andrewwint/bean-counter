import type { Pool, PoolClient } from 'pg';
import { pool } from '../db.ts';
import { upcast } from '../events/schema.ts';

/** A row of the stock board, in base units (g / ml / each). */
export interface StockRow {
  itemId: string;
  name: string;
  category: string;
  baseUnit: string;
  quantity: number;
  lastEventAt: string | null;
}

export interface HistoryRow {
  sequence: number;
  eventType: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * Refresh `item_stock`. CONCURRENTLY keeps readers unblocked and is what the
 * unique index in 002_item_stock.sql exists for.
 */
export async function refreshItemStock(executor: Pool | PoolClient = pool): Promise<void> {
  await executor.query('REFRESH MATERIALIZED VIEW CONCURRENTLY item_stock');
}

export async function listStock(executor: Pool | PoolClient = pool): Promise<StockRow[]> {
  const { rows } = await executor.query<{
    item_id: string;
    name: string;
    category: string;
    base_unit: string;
    quantity: number;
    last_event_at: Date | null;
  }>(
    `SELECT item_id, name, category, base_unit, quantity, last_event_at
       FROM item_stock
      ORDER BY category, name`,
  );

  return rows.map((r) => ({
    itemId: r.item_id,
    name: r.name,
    category: r.category,
    baseUnit: r.base_unit,
    quantity: r.quantity,
    lastEventAt: r.last_event_at ? r.last_event_at.toISOString() : null,
  }));
}

/** Full replay of one item's stream, oldest first. */
export async function getItemHistory(
  itemId: string,
  executor: Pool | PoolClient = pool,
): Promise<HistoryRow[]> {
  const { rows } = await executor.query<{
    sequence: number;
    event_type: string;
    event_version: number;
    payload: unknown;
    occurred_at: Date;
  }>(
    `SELECT sequence, event_type, event_version, payload, occurred_at
       FROM events
      WHERE stream_id = $1
      ORDER BY sequence`,
    [itemId],
  );

  return rows.map((r) => ({
    sequence: r.sequence,
    eventType: r.event_type,
    // Readers switch on event_version; every stored payload is walked forward
    // to the current shape before it leaves the backend.
    payload: upcast(r.event_type, r.event_version, r.payload),
    occurredAt: r.occurred_at.toISOString(),
  }));
}
