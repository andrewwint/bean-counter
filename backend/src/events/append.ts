import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db.ts';
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
  /** True when this `eventId` was already in the log and nothing new was written. */
  replayed: boolean;
}

/**
 * A client reused an `eventId` for a materially different fact.
 *
 * Returning the original event's sequence here would be "idempotent" and also
 * silently lose a real delivery — the one failure mode an inventory log must
 * not have. The caller is told instead (409); see the route.
 */
export class EventIdConflictError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`eventId ${eventId} is already recorded for a different event`);
    this.name = 'EventIdConflictError';
    this.eventId = eventId;
  }
}

/**
 * Key order in a stored `jsonb` is not the key order we sent, so payloads are
 * compared canonically. Payloads are flat objects of strings and integers.
 */
function canonical(payload: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))),
  );
}

export async function appendEvent(
  event: ValidatedEvent,
  executor: Pool | PoolClient = pool,
): Promise<AppendedEvent> {
  const eventId = event.eventId ?? randomUUID();

  // ON CONFLICT, never read-then-write: two retries of the same eventId can be
  // in flight at once, and the UNIQUE index on event_id is the only thing that
  // can arbitrate between them. DO NOTHING makes the loser wait for the
  // winner's transaction to finish and then return no row.
  const { rows } = await executor.query<{ sequence: number }>(
    `INSERT INTO events (event_id, stream_id, event_type, event_version, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
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
  if (sequence !== undefined) return { eventId, sequence, replayed: false };

  // The id is already in the log. Answer with the ORIGINAL event so a retry is
  // indistinguishable from the first success — but only if it is the same fact.
  const existing = await executor.query<{
    sequence: number;
    stream_id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }>('SELECT sequence, stream_id, event_type, payload FROM events WHERE event_id = $1', [eventId]);

  const original = existing.rows[0];
  if (!original) throw new Error('append failed: no sequence returned');

  // `occurredAt` is deliberately NOT part of the comparison: it defaults to
  // now() when the client omits it (a known slice-1 limitation), so an honest
  // retry of the same body carries a different timestamp. The fact is the type,
  // the stream and the payload. First write wins for the timestamp.
  if (
    original.event_type !== event.type ||
    original.stream_id !== event.streamId ||
    canonical(original.payload) !== canonical(event.payload)
  ) {
    throw new EventIdConflictError(eventId);
  }

  return { eventId, sequence: original.sequence, replayed: true };
}

/**
 * Append and bring the read model up to date, atomically.
 *
 * ONE transaction on ONE checked-out client. Before this, the insert committed
 * on the pool's autocommit path and the refresh ran afterwards as a separate
 * statement, so a refresh failure returned `500 INTERNAL` for an event that was
 * already durably in the log — the response contradicted the log. Now a refresh
 * failure rolls the insert back and a 500 truthfully means nothing happened.
 *
 * TRADE-OFF (chosen deliberately): the refresh inside the transaction is NOT
 * `CONCURRENTLY`, because Postgres forbids that inside a transaction block. The
 * plain form takes an ACCESS EXCLUSIVE lock on `item_stock`, so stock-board
 * readers block for the duration of the refresh and concurrent appends
 * serialise behind it. That is the right price here: slice 1 already accepted
 * an O(whole log) re-fold on every write at a coffee shop's event volume, and
 * the alternative — committing the event and reporting "written, but the board
 * is stale" — buys concurrency by giving the client a second outcome to handle
 * and leaving the board wrong until the next write. Correct-and-briefly-locked
 * beats fast-and-ambiguous for a one-till shop. When that stops being true it
 * is the projection table (`add-projection-table`) that fixes it, not a looser
 * response contract.
 *
 * Lock order is always insert-then-refresh, so concurrent appends cannot
 * deadlock against each other.
 */
export async function appendEventAndRefresh(
  event: ValidatedEvent,
  db: Pool = pool,
): Promise<AppendedEvent> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const appended = await appendEvent(event, client);
    // A replay wrote nothing, so the read model cannot have changed — and
    // skipping the refresh keeps a storm of retries off the exclusive lock.
    if (!appended.replayed) await client.query('REFRESH MATERIALIZED VIEW item_stock');
    await client.query('COMMIT');
    return appended;
  } catch (error) {
    // Never let a failed ROLLBACK (e.g. a dropped connection) mask the real
    // cause; the pool discards a client that errors on release anyway.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
