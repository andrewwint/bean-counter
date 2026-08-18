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
