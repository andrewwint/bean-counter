import { Hono } from 'hono';
import { getItemReconciliation, listReconciliation } from '../readmodel/reconciliation.ts';

export const reconciliation = new Hono();

/** The shop-wide shrinkage report, most negative variance first. */
reconciliation.get('/reconciliation', async (c) => {
  return c.json(await listReconciliation());
});

reconciliation.get('/items/:itemId/reconciliation', async (c) => {
  const itemId = c.req.param('itemId');
  const report = await getItemReconciliation(itemId);

  // Never counted is a 200 with an empty `counts`. Only a never-DEFINED item
  // is a 404 — there is no such thing to reconcile.
  if (!report) {
    return c.json({ error: { code: 'NOT_FOUND', message: `no such item: ${itemId}` } }, 404);
  }

  return c.json(report);
});
