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
 * Every quantity in the system is an integer in a base unit (g / ml / each) and
 * strictly positive. Floats and zero/negative quantities are rejected at the
 * boundary: "1.5 kg" is a UI concern, and a zero-quantity movement is not an
 * event that happened.
 */
const quantitySchema = z
  .number({ invalid_type_error: 'quantity must be a number of base units (g / ml / each)' })
  .int('quantity must be an integer in the base unit — no floats')
  .positive('quantity must be greater than zero');

const itemIdSchema = z.string().min(1, 'itemId is required');

export const eventSchemas = {
  ItemDefined: z
    .object({
      itemId: itemIdSchema,
      name: z.string().min(1),
      category: z.string().min(1),
      baseUnit: baseUnitSchema,
    })
    .strict(),

  StockReceived: z
    .object({
      itemId: itemIdSchema,
      quantity: quantitySchema,
      supplier: z.string().min(1).optional(),
      lotId: z.string().min(1).optional(),
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
        .nonnegative('countedQuantity cannot be negative'),
    })
    .strict(),
} as const;

export type EventType = keyof typeof eventSchemas;

export const EVENT_TYPES = Object.keys(eventSchemas) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(eventSchemas, value);
}

/** The request envelope: `{ type, occurredAt?, ...payload }`. */
const envelopeSchema = z
  .object({
    type: z.string().min(1, 'type is required'),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export interface ValidatedEvent {
  type: EventType;
  streamId: string;
  eventVersion: number;
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
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new ValidationError('INVALID_EVENT', 'invalid event envelope', envelope.error.issues);
  }

  const { type, occurredAt, ...payload } = envelope.data;
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
    occurredAt: occurredAt ?? new Date().toISOString(),
    payload: parsed.data,
  };
}
