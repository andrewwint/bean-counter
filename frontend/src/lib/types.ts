/** Response and event shapes, mirroring docs/architecture/slice-1-contract.md. */
import type { BaseUnit } from './units.ts';

/** A row of `GET /api/stock`. */
export interface StockItem {
  itemId: string;
  name: string;
  category: string;
  baseUnit: BaseUnit;
  /** Integer, in `baseUnit`. */
  quantity: number;
  /** ISO timestamp of the item's most recent event, or null if it has none. */
  lastEventAt: string | null;
}

/** A row of `GET /api/items/:itemId/history`. */
export interface HistoryEntry {
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type DepletionReason = 'sale' | 'waste' | 'sample';

/** Bodies accepted by `POST /api/events` (v1 event types). */
export type NewEvent =
  | { type: 'StockReceived'; itemId: string; quantity: number; supplier?: string; lotId?: string }
  | { type: 'StockDepleted'; itemId: string; quantity: number; reason: DepletionReason };

export interface AppendedEvent {
  eventId: string;
  sequence: number;
}

/**
 * What `postEvent` made of the append. `replayed` is true when the server
 * recognised the `eventId` and returned the original write (HTTP 200) instead
 * of appending a second one — the fact is recorded, exactly once.
 */
export interface AppendResult extends AppendedEvent {
  replayed: boolean;
}

/**
 * A row of `GET /api/reconciliation` — the shop-wide shrinkage report.
 * The API returns these ranked by `totalVariancePct`, most negative first, with
 * items that have nothing scorable last; that order is the report.
 */
export interface ReconciliationRow {
  itemId: string;
  name: string;
  category: string;
  baseUnit: BaseUnit;
  /** Signed integer in `baseUnit`: negative is shrinkage, positive is overage. */
  totalVariance: number;
  /**
   * The ranking key: variance over expected across this item's *scored* counts,
   * unit-free so grams, millilitres and "each" can be compared. Null when there
   * is nothing scorable — never counted, or counted only as an opening balance.
   */
  totalVariancePct: number | null;
  /** ISO timestamp of the most recent count, or null when never counted. */
  lastCountAt: string | null;
  countsRecorded: number;
}

/** One `StockCounted`, reconciled against what the log predicted at that moment. */
export interface ReconciliationCount {
  sequence: number;
  occurredAt: string;
  /** Integers in the item's base unit. */
  countedQuantity: number;
  expectedQuantity: number;
  /**
   * `countedQuantity - expectedQuantity`. Negative is shrinkage. Null on an
   * opening balance: nothing in the log preceded the count, so there was no
   * prediction to be wrong about — that is not a variance of zero.
   */
  variance: number | null;
  /** Null when `expectedQuantity` was 0 — there is no denominator. */
  variancePct: number | null;
  /**
   * True when this count is the shop's starting count. Present on every row
   * (`false` on a scored one) and the *only* discriminator: neither
   * `variance === null` nor `expectedQuantity === 0` means opening balance.
   */
  isOpeningBalance: boolean;
}

/** Movement recorded after the most recent count. */
export interface SinceLastCount {
  received: number;
  depleted: Record<DepletionReason, number>;
  expectedQuantity: number;
}

/** `GET /api/items/:itemId/reconciliation`. */
export interface ItemReconciliation {
  itemId: string;
  name: string;
  baseUnit: BaseUnit;
  /** Chronological by sequence. Empty — not an error — when never counted. */
  counts: ReconciliationCount[];
  /** Across the scored counts only — opening balances contribute nothing. */
  totalVariance: number;
  sinceLastCount: SinceLastCount;
}
