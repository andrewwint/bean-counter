import { Hono } from 'hono';
import { listStock } from '../readmodel/stock.ts';

export const stock = new Hono();

stock.get('/stock', async (c) => {
  return c.json(await listStock());
});
