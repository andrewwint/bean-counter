import { describe, expect, it } from 'vitest';
import { ValidationError, validateEvent } from '../src/events/schema.ts';

/**
 * Validation happens before append, so these never reach the database — that is
 * the property under test: the log cannot contain them.
 */

function expectRejected(body: unknown, code: string): ValidationError {
  try {
    validateEvent(body);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(code);
    return error as ValidationError;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be rejected`);
}

describe('event validation', () => {
  it('rejects a zero quantity', () => {
    expectRejected({ type: 'StockReceived', itemId: 'x', quantity: 0 }, 'INVALID_EVENT');
  });

  it('rejects a negative quantity', () => {
    expectRejected({ type: 'StockDepleted', itemId: 'x', quantity: -5, reason: 'sale' }, 'INVALID_EVENT');
  });

  it('rejects a non-integer quantity', () => {
    // 1.5 kg is a display concern; storage is integer grams.
    expectRejected({ type: 'StockReceived', itemId: 'x', quantity: 1500.5 }, 'INVALID_EVENT');
  });

  it('rejects a quantity that is not a number', () => {
    expectRejected({ type: 'StockReceived', itemId: 'x', quantity: '1500' }, 'INVALID_EVENT');
  });

  it('rejects an unknown event type', () => {
    const error = expectRejected({ type: 'StockVapourised', itemId: 'x' }, 'UNKNOWN_EVENT_TYPE');
    expect(error.message).toContain('StockVapourised');
  });

  it('rejects an unknown reason and an unknown base unit', () => {
    expectRejected({ type: 'StockDepleted', itemId: 'x', quantity: 1, reason: 'shrinkage' }, 'INVALID_EVENT');
    expectRejected({ type: 'ItemDefined', itemId: 'x', name: 'X', category: 'c', baseUnit: 'kg' }, 'INVALID_EVENT');
  });

  it('rejects unknown payload fields rather than silently dropping them', () => {
    expectRejected({ type: 'StockReceived', itemId: 'x', quantity: 1, qty: 2 }, 'INVALID_EVENT');
  });

  it('accepts a zero physical count — "we are out" is a real observation', () => {
    const event = validateEvent({ type: 'StockCounted', itemId: 'x', countedQuantity: 0 });
    expect(event.payload).toEqual({ itemId: 'x', countedQuantity: 0 });
  });

  it('stamps event_version and defaults occurredAt', () => {
    const event = validateEvent({ type: 'StockReceived', itemId: 'x', quantity: 1 });
    expect(event.eventVersion).toBe(1);
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  });
});
