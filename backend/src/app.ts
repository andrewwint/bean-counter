import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ValidationError } from './events/schema.ts';
import { events } from './routes/events.ts';
import { health } from './routes/health.ts';
import { stock } from './routes/stock.ts';

/** The Vite dev server. Not a blanket `*` — one named origin, dev only. */
const DEV_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

export function createApp(): Hono {
  const app = new Hono();

  // In production the frontend is expected to be served same-origin (or behind
  // a reverse proxy), so no CORS headers are emitted at all.
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/*', cors({ origin: DEV_ORIGIN, allowMethods: ['GET', 'POST', 'OPTIONS'] }));
  }

  app.route('/api', health);
  app.route('/api', events);
  app.route('/api', stock);

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'no such route' } }, 404));

  app.onError((error, c) => {
    if (error instanceof ValidationError) {
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        400,
      );
    }
    console.error(error);
    return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  });

  return app;
}
