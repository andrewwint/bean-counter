import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool, pool } from '../src/db.ts';
import { quantityOf, resetDatabase } from './helpers.ts';

/**
 * The retry a barista actually performs.
 *
 * A "received 12 kg" that appears to fail gets pressed again. Without an
 * idempotency handle the log then permanently holds 24 kg, and an append-only
 * log has no way back — only a compensating event and a confused audit trail.
 * So the client may name the fact (`eventId`), and naming it twice records it
 * once.
 */

const app = createApp();

const post = (body: unknown) =>
  app.request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const countEvents = async (): Promise<number> => {
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::bigint AS count FROM events',
  );
  return rows[0]!.count;
};

const defineBeans = () =>
  post({
    type: 'ItemDefined',
    itemId: 'bean-yirg',
    name: 'Yirgacheffe',
    category: 'beans',
    baseUnit: 'g',
  });

const RETRY_ID = '3f1b0c2e-5a4d-4c8b-9e21-7d6f0a1b2c3d';

const receive12kg = (extra: Record<string, unknown> = {}) =>
  post({
    type: 'StockReceived',
    eventId: RETRY_ID,
    itemId: 'bean-yirg',
    quantity: 12000,
    supplier: 'Bay Provisions',
    occurredAt: '2026-08-05T13:20:00.000Z',
    ...extra,
  });

beforeEach(resetDatabase);
afterAll(closePool);

describe('idempotent append by client-supplied eventId', () => {
  it('records one delivery when the barista presses receive twice', async () => {
    await defineBeans();

    const first = await receive12kg();
    const retry = await receive12kg();

    expect(first.status).toBe(201);
    // A replay created nothing, so it is not a 201. Same body shape either way.
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());

    // The whole point: 12 kg, not 24 kg.
    expect(await quantityOf('bean-yirg')).toBe(12000);
    expect(await countEvents()).toBe(2); // ItemDefined + one StockReceived
  });

  it('lands exactly one row when the same eventId arrives in parallel', async () => {
    await defineBeans();

    // A flaky till firing the same retry from several tabs at once. Sequential
    // retries would pass on a read-then-write check; these do not.
    const responses = await Promise.all(Array.from({ length: 8 }, () => receive12kg()));
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      eventId: string;
      sequence: number;
    }>;

    // Exactly one caller created the event; everyone else replayed it.
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(7);

    // Every caller was told the same thing, and it is what is in the log.
    expect(new Set(bodies.map((b) => b.sequence)).size).toBe(1);
    expect(new Set(bodies.map((b) => b.eventId))).toEqual(new Set([RETRY_ID]));
    expect(await countEvents()).toBe(2);
    expect(await quantityOf('bean-yirg')).toBe(12000);
  });

  it('keeps generating an id server-side when the client supplies none', async () => {
    await defineBeans();

    // The frontend sends no eventId; two identical posts are two real facts.
    const a = await post({ type: 'StockDepleted', itemId: 'bean-yirg', quantity: 18, reason: 'sale' });
    const b = await post({ type: 'StockDepleted', itemId: 'bean-yirg', quantity: 18, reason: 'sale' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{ eventId: string }>;
    expect(bodies[0]!.eventId).not.toBe(bodies[1]!.eventId);
    expect(await countEvents()).toBe(3);
  });

  it('rejects a malformed eventId with 400 INVALID_EVENT', async () => {
    const response = await post({
      type: 'StockReceived',
      eventId: 'not-a-uuid',
      itemId: 'bean-yirg',
      quantity: 1,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_EVENT');
    expect(await countEvents()).toBe(0);
  });

  it('refuses to let a second, different fact hide behind an already-used eventId', async () => {
    await defineBeans();
    await receive12kg();

    // Same handle, different quantity: this is a different fact. Returning the
    // original's sequence would silently swallow a real 5 kg delivery, so it is
    // a conflict, not a replay.
    const different = await receive12kg({ quantity: 5000 });

    expect(different.status).toBe(409);
    const body = (await different.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('EVENT_ID_CONFLICT');
    expect(await countEvents()).toBe(2);
    expect(await quantityOf('bean-yirg')).toBe(12000);
  });

  it('treats a retry that omits the server-defaulted occurredAt as the same fact', async () => {
    await defineBeans();

    const first = await receive12kg();
    // `occurredAt` is optional and defaults to now(), so a retry of the same
    // body carries a different timestamp. That must not read as a new fact.
    const retry = await receive12kg({ occurredAt: undefined });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await countEvents()).toBe(2);
  });
});
