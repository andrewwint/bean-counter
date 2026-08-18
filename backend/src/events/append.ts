import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db.ts';
import { refreshItemStock } from '../readmodel/stock.ts';
import type { ValidatedEvent } from './schema.ts';

/**
 * Append one event to the log.
 *
 * APPEND ONLY: this INSERT is the only write against `events` in the entire
 * codebase. There is no UPDATE and no DELETE anywhere — grep for it. A mistake
 * is corrected by appending a correcting event (a StockCounted, usually).
 *
 * The caller must have validated first (see `validateEvent`); this function
 * takes an already-`ValidatedEvent` precisely so the "validate before append"
 * rule is carried by the type rather than by a comment.
 */
export interface AppendedEvent {
  eventId: string;
  sequence: number;
}

export async function appendEvent(
  event: ValidatedEvent,
  executor: Pool | PoolClient = pool,
): Promise<AppendedEvent> {
  const eventId = randomUUID();

  const { rows } = await executor.query<{ sequence: number }>(
    `INSERT INTO events (event_id, stream_id, event_type, event_version, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING sequence`,
    [
      eventId,
      event.streamId,
      event.type,
      // Written on every event from day one; readers switch on it. See upcast().
      event.eventVersion,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );

  const sequence = rows[0]?.sequence;
  if (sequence === undefined) throw new Error('append failed: no sequence returned');

  return { eventId, sequence };
}

/**
 * Append, then bring the read model up to date.
 *
 * SLICE-1 SIMPLIFICATION (deliberate): the materialized view is refreshed
 * synchronously on the write path, so a POST costs a full re-fold of the log.
 * That is fine at a coffee shop's event volume and it keeps the read model
 * obviously correct. Slice 2 replaces it with an in-transaction projection
 * table updated incrementally.
 */
export async function appendEventAndRefresh(
  event: ValidatedEvent,
  executor: Pool | PoolClient = pool,
): Promise<AppendedEvent> {
  const appended = await appendEvent(event, executor);
  // CONCURRENTLY cannot run inside a transaction block, so this is a separate
  // statement after the insert has committed.
  await refreshItemStock(executor);
  return appended;
}
