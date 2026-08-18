import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

/**
 * Bind to loopback by default.
 *
 * With no `hostname`, Node listens on `::` — every interface, including the
 * LAN. `POST /api/events` has no auth gate in slice 1 (see routes/events.ts),
 * so "localhost only" has to be enforced here in code, not asserted in a
 * README. Override with `HOST` when something in front of this service is doing
 * the access control (a reverse proxy, or a container's published port).
 */
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  // Print the address actually bound, not an assumption about it.
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  console.log(`bean-counter backend listening on http://${host}:${info.port}`);
});
