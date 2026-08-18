import { Hono } from 'hono';
import { pool } from '../db.ts';

export const health = new Hono();

health.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ok', db: true });
  } catch {
    return c.json({ status: 'degraded', db: false }, 503);
  }
});
