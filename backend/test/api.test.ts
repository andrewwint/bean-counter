import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/db.ts';
import { record, resetDatabase } from './helpers.ts';

/** The HTTP surface from the contract, against the real database. */

const app = createApp();

const post = (body: unknown) =>
  app.request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(resetDatabase);
afterAll(closePool);

describe('HTTP API', () => {
  it('reports health with a live db check', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', db: true });
  });

  it('appends a valid event and returns its id and sequence', async () => {
    const defined = await post({
      type: 'ItemDefined',
      itemId: 'cup-12oz',
      name: '12oz Cup',
      category: 'packaging',
      baseUnit: 'each',
    });
    expect(defined.status).toBe(201);

    const received = await post({
      type: 'StockReceived',
      itemId: 'cup-12oz',
      quantity: 1000,
      supplier: 'Bay Provisions',
      occurredAt: '2026-08-05T13:20:00.000Z',
    });
    expect(received.status).toBe(201);

    const body = (await received.json()) as { eventId: string; sequence: number };
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sequence).toBeGreaterThan(0);
  });

  it('rejects an invalid event with 400 and the contract error shape', async () => {
    const response = await post({ type: 'StockReceived', itemId: 'cup-12oz', quantity: -1 });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_EVENT');
    expect(body.error.message).toContain('StockReceived');
  });

  it('rejects an unknown event type with 400', async () => {
    const response = await post({ type: 'Nonsense', itemId: 'x' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_EVENT_TYPE',
    );
  });

  it('serves the stock board with the read model refreshed after each append', async () => {
    await post({
      type: 'ItemDefined',
      itemId: 'milk-oat',
      name: 'Oat Milk',
      category: 'milk',
      baseUnit: 'ml',
      occurredAt: '2026-08-03T14:00:00.000Z',
    });
    await post({
      type: 'StockReceived',
      itemId: 'milk-oat',
      quantity: 12000,
      occurredAt: '2026-08-05T13:20:00.000Z',
    });
    await post({
      type: 'StockDepleted',
      itemId: 'milk-oat',
      quantity: 3500,
      reason: 'sale',
      occurredAt: '2026-08-08T20:30:00.000Z',
    });

    const response = await app.request('/api/stock');
    expect(response.status).toBe(200);

    const rows = (await response.json()) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        itemId: 'milk-oat',
        name: 'Oat Milk',
        category: 'milk',
        baseUnit: 'ml',
        quantity: 8500,
        lastEventAt: '2026-08-08T20:30:00.000Z',
      },
    ]);
  });

  it('replays one item history in sequence order', async () => {
    await record({ type: 'ItemDefined', itemId: 'bean-huila', name: 'Huila', category: 'beans', baseUnit: 'g' });
    await record({ type: 'StockCounted', itemId: 'bean-huila', countedQuantity: 8000 });
    await record({ type: 'StockDepleted', itemId: 'bean-huila', quantity: 400, reason: 'waste' });

    const response = await app.request('/api/items/bean-huila/history');
    const rows = (await response.json()) as Array<{ eventType: string; sequence: number }>;

    expect(rows.map((r) => r.eventType)).toEqual(['ItemDefined', 'StockCounted', 'StockDepleted']);
    expect(rows.map((r) => r.sequence)).toEqual([...rows].sort((a, b) => a.sequence - b.sequence).map((r) => r.sequence));
  });

  it('allows the Vite dev origin only, never a wildcard', async () => {
    const response = await app.request('/api/stock', { headers: { Origin: 'http://localhost:5173' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const other = await app.request('/api/stock', { headers: { Origin: 'http://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('404s an unknown route with the error shape', async () => {
    const response = await app.request('/api/nope');
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
