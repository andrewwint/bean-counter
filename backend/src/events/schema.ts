import { z } from 'zod';

/**
 * Event schemas (v1).
 *
 * Validation happens HERE, before anything is appended: the log only ever
 * contains valid history. There is no cleanup pass downstream, because there
 * cannot be — `events` is append-only.
 */

/** The version stamped on every event we write today. */
export const CURRENT_EVENT_VERSION = 1;

/**
 * Upcasting convention, for the reader who arrives at v2:
 *
 * `event_version` is stored on every row and readers switch on it. When a
 * payload shape changes, do NOT rewrite stored rows. Instead bump
 * `CURRENT_EVENT_VERSION`, keep the old schema around, and add a pure function
 * `upcast(eventType, version, payload)` that walks a v(n) payload forward one
 * version at a time until it matches the current shape. Every read path goes
 * through it. History keeps the bytes that were true when it happened.
 */
export function upcast(_eventType: string, version: number, payload: unknown): unknown {
  // Only v1 exists, so this is the identity. The switch is here so the seam is
  // obvious and v2 has an unambiguous place to land.
  switch (version) {
    case 1:
      return payload;
    default:
      throw new Error(`unsupported event_version ${version}`);
  }
}

/** Base units are integers only — see the contract's drift-prevention rule. */
export const baseUnitSchema = z.enum(['g', 'ml', 'each']);

/**
 * The upper bound on every quantity in the system.
 *
 * `.int()` alone is `Number.isInteger`, which happily accepts 1e19. That value
 * survives JSON, survives the append, and then overflows `::bigint` in the fold
 * (migrations/002_item_stock.sql) — the read model can never refresh again and
 * the log is append-only, so there is no way back. The bound belongs HERE, at
 * the boundary, and is repeated as a CHECK in migrations/003 in case it is ever
 * bypassed. MAX_SAFE_INTEGER is well inside int8 and is also the largest value
 * JSON can round-trip through a double without silently changing.
 */
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

/**
 * Every quantity in the system is an integer in a base unit (g / ml / each) and
 * strictly positive. Floats and zero/negative quantities are rejected at the
 * boundary: "1.5 kg" is a UI concern, and a zero-quantity movement is not an
 * event that happened.
 */
const quantitySchema = z
  .number({ invalid_type_error: 'quantity must be a number of base units (g / ml / each)' })
  .int('quantity must be an integer in the base unit — no floats')
  .positive('quantity must be greater than zero')
  .max(MAX_QUANTITY, `quantity must be at most ${MAX_QUANTITY}`);

/**
 * Identifiers and labels are trimmed, and must survive the trim. `min(1)` alone
 * accepts "   ", which would open a stream whose id is three spaces.
 */
const nonBlankString = (message: string) => z.string().trim().min(1, message);

const itemIdSchema = nonBlankString('itemId is required');

export const eventSchemas = {
  ItemDefined: z
    .object({
      itemId: itemIdSchema,
      name: nonBlankString('name is required'),
      category: nonBlankString('category is required'),
      baseUnit: baseUnitSchema,
    })
    .strict(),

  StockReceived: z
    .object({
      itemId: itemIdSchema,
      quantity: quantitySchema,
      supplier: nonBlankString('supplier cannot be blank').optional(),
      lotId: nonBlankString('lotId cannot be blank').optional(),
    })
    .strict(),

  StockDepleted: z
    .object({
      itemId: itemIdSchema,
      quantity: quantitySchema,
      reason: z.enum(['sale', 'waste', 'sample']),
    })
    .strict(),

  /** An absolute reset, not a delta — a physical count of what is on the shelf. */
  StockCounted: z
    .object({
      itemId: itemIdSchema,
      // A count of zero is legitimate ("we're out"), so this one allows 0 —
      // but it is still an integer in the base unit.
      countedQuantity: z
        .number({ invalid_type_error: 'countedQuantity must be a number of base units' })
        .int('countedQuantity must be an integer in the base unit — no floats')
        .nonnegative('countedQuantity cannot be negative')
        .max(MAX_QUANTITY, `countedQuantity must be at most ${MAX_QUANTITY}`),
    })
    .strict(),
} as const;

export type EventType = keyof typeof eventSchemas;

export const EVENT_TYPES = Object.keys(eventSchemas) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(eventSchemas, value);
}

/** The request envelope: `{ type, eventId?, occurredAt?, ...payload }`. */
const envelopeSchema = z
  .object({
    type: z.string().min(1, 'type is required'),
    // The idempotency handle: a client that retries names the fact it already
    // sent, so the retry records it once. Optional — when it is absent the id
    // is generated server-side, which is what the frontend does today.
    eventId: z.string().uuid('eventId must be a UUID').optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export interface ValidatedEvent {
  type: EventType;
  streamId: string;
  eventVersion: number;
  /** Client-supplied idempotency handle; generated at append time when absent. */
  eventId?: string | undefined;
  /** ISO-8601; defaults to now when the caller does not say when it happened. */
  occurredAt: string;
  payload: Record<string, unknown>;
}

export class ValidationError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Parse an inbound request body into an event that is safe to append.
 * Throws `ValidationError` — never returns a partially-valid event.
 */
export function validateEvent(body: unknown): ValidatedEvent {
  // `.strict()` never sees `__proto__`: zod builds its output by assignment, and
  // assigning that key sets a prototype instead of creating an own property, so
  // the field vanishes before the unknown-key check runs. The contract says
  // unknown fields are REJECTED, not silently dropped, so reject it here.
  if (typeof body === 'object' && body !== null && Object.hasOwn(body, '__proto__')) {
    throw new ValidationError('INVALID_EVENT', 'invalid event envelope', [
      { path: ['__proto__'], message: 'unrecognized key: "__proto__"' },
    ]);
  }

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new ValidationError('INVALID_EVENT', 'invalid event envelope', envelope.error.issues);
  }

  const { type, eventId, occurredAt, ...payload } = envelope.data;
  if (!isEventType(type)) {
    throw new ValidationError(
      'UNKNOWN_EVENT_TYPE',
      `unknown event type "${type}"`,
      { known: EVENT_TYPES },
    );
  }

  const parsed = eventSchemas[type].safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('INVALID_EVENT', `invalid ${type} payload`, parsed.error.issues);
  }

  return {
    type,
    streamId: parsed.data.itemId,
    eventVersion: CURRENT_EVENT_VERSION,
    eventId,
    occurredAt: occurredAt ?? new Date().toISOString(),
    payload: parsed.data,
  };
}
