import { Hono } from 'hono';
import { appendEventAndRefresh } from '../events/append.ts';
import { validateEvent } from '../events/schema.ts';
import { getItemHistory } from '../readmodel/stock.ts';

export const events = new Hono();

/**
 * AUTH BOUNDARY (slice 1 ships without one, deliberately).
 *
 * This is the only write endpoint in the system, so this is where
 * authentication and authorization would go — an auth middleware on this route
 * establishing who is recording the event, and the resulting identity written
 * into the event envelope (an `actor` column) so the log says who did what.
 * Slice 1 has no auth gate on purpose and that boundary is under separate
 * review; no scheme is invented here. Do not expose this service beyond
 * localhost until that review lands.
 */
events.post('/events', async (c) => {
  const body = await c.req.json().catch(() => null);

  // Validate BEFORE append — the log only ever contains valid history.
  const event = validateEvent(body);

  const appended = await appendEventAndRefresh(event);
  return c.json(appended, 201);
});

events.get('/items/:itemId/history', async (c) => {
  return c.json(await getItemHistory(c.req.param('itemId')));
});
