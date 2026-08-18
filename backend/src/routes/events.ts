import { Hono } from 'hono';
import { EventIdConflictError, appendEventAndRefresh } from '../events/append.ts';
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

  let appended;
  try {
    appended = await appendEventAndRefresh(event);
  } catch (error) {
    // Reusing an eventId for a different fact is the client's mistake, and the
    // honest answer is to say so rather than swallow the second fact.
    if (error instanceof EventIdConflictError) {
      return c.json({ error: { code: 'EVENT_ID_CONFLICT', message: error.message } }, 409);
    }
    throw error;
  }

  // 201 only when this request actually created the event; a replay created
  // nothing, so it answers 200. The body is identical either way, so a client
  // that retries cannot tell which of its attempts won — that is the point.
  const { eventId, sequence } = appended;
  return appended.replayed ? c.json({ eventId, sequence }, 200) : c.json({ eventId, sequence }, 201);
});

events.get('/items/:itemId/history', async (c) => {
  return c.json(await getItemHistory(c.req.param('itemId')));
});
