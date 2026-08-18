-- 005_reconciliation.sql — variance: what the log predicted vs what the shelf held.
--
-- 002_item_stock.sql answers "how much do we have?" for the LATEST count only.
-- This file is that same recurrence generalized to EVERY count, which is what
-- makes shrinkage visible (docs/architecture/slice-2-reconciliation-contract.md):
--
--   expectedAtCount(c) = previous count's countedQuantity (0 if there is none)
--                      + sum of receipts/depletions between that count and c
--   variance(c)        = c.countedQuantity - expectedAtCount(c)
--
--   variance < 0  shrinkage (over-dosing, spillage, unrecorded waste, theft)
--   variance > 0  overage   (usually a delivery nobody wrote down)
--
-- One count is NOT a variance: the first count of an item whose log holds no
-- movement yet. That is an OPENING BALANCE — the log made no prediction, so
-- there is nothing for the shelf to disagree with. Scoring it would book the
-- shop's entire opening stock as overage and bury the real shortfall. Such a
-- row carries `is_opening_balance = true` and a NULL variance, so every
-- `sum(variance)` downstream skips it for free.
--
-- Nothing here touches `item_stock`. These are plain (non-materialized) VIEWS:
-- they read `events` directly, so they cannot go stale and there is nothing to
-- REFRESH after an append.

-- The whole log, cut into EPOCHS. An epoch is the span between two physical
-- counts: epoch 0 runs from the item's first event up to and including its
-- first count, epoch 1 from there to the second count, and so on. The trailing
-- epoch (number = the item's total count of counts) is "since the last count".
--
-- The window counts how many StockCounted rows came STRICTLY BEFORE this row
-- (`... AND 1 PRECEDING`), which is exactly the epoch number. Because a count
-- is the last row of its own epoch, "the movements that belong to count c" is
-- just "the rows sharing c's epoch" — no correlated sequence comparison needed.
CREATE OR REPLACE VIEW item_event_epochs AS
SELECT
  e.stream_id AS item_id,
  e.sequence,
  e.occurred_at,
  e.event_type,
  -- Movement, signed. Integers in a base unit, so the sums stay exact.
  CASE e.event_type
    WHEN 'StockReceived' THEN  (e.payload ->> 'quantity')::bigint
    WHEN 'StockDepleted' THEN -(e.payload ->> 'quantity')::bigint
    ELSE 0::bigint
  END AS delta,
  CASE WHEN e.event_type = 'StockDepleted' THEN e.payload ->> 'reason' END AS reason,
  CASE WHEN e.event_type = 'StockCounted'
       THEN (e.payload ->> 'countedQuantity')::bigint END AS counted_quantity,
  count(*) FILTER (WHERE e.event_type = 'StockCounted') OVER (
    PARTITION BY e.stream_id
    ORDER BY e.sequence
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS epoch,
  -- How many events that actually PREDICT a quantity came before this row.
  -- ItemDefined is excluded deliberately: naming an item forecasts nothing, so
  -- a first count preceded only by a definition still has an empty history.
  -- This is the discriminator for an opening balance — "was anything known
  -- before this count?", NOT "did it work out to zero?". An item that was
  -- received and then counted at 0 has a real, and very bad, variance.
  count(*) FILTER (
    WHERE e.event_type IN ('StockReceived', 'StockDepleted', 'StockCounted')
  ) OVER (
    PARTITION BY e.stream_id
    ORDER BY e.sequence
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS prior_predicting_events
FROM events e;

-- One row per physical count: what the shelf said, what the log predicted, and
-- the gap between them.
CREATE OR REPLACE VIEW item_count_variance AS
WITH counts AS (
  SELECT
    item_id,
    sequence,
    occurred_at,
    counted_quantity,
    epoch,
    prior_predicting_events = 0 AS is_opening_balance,
    -- The baseline is the PREVIOUS count, not zero. A count is an absolute
    -- reset, so everything before it has already been superseded. `lag` runs
    -- after the WHERE, so it steps count-to-count, skipping movements.
    coalesce(lag(counted_quantity) OVER (PARTITION BY item_id ORDER BY sequence), 0) AS baseline
  FROM item_event_epochs
  WHERE event_type = 'StockCounted'
),
-- Net movement inside each epoch. The count row itself contributes 0.
epoch_delta AS (
  SELECT item_id, epoch, sum(delta) AS delta
  FROM item_event_epochs
  GROUP BY item_id, epoch
)
SELECT
  c.item_id,
  c.sequence,
  c.occurred_at,
  c.counted_quantity,
  (c.baseline + coalesce(d.delta, 0))::bigint AS expected_quantity,
  -- NULL, not 0, for an opening balance: "no prediction to be wrong about" is
  -- a different fact from "the prediction was exactly right".
  CASE WHEN c.is_opening_balance THEN NULL
       ELSE (c.counted_quantity - (c.baseline + coalesce(d.delta, 0)))::bigint
  END AS variance,
  c.is_opening_balance
FROM counts c
LEFT JOIN epoch_delta d ON d.item_id = c.item_id AND d.epoch = c.epoch;

-- Movement after the most recent count, per item.
--
-- `expected_quantity` here is the same number `item_stock.quantity` holds, but
-- reached by a different route (epoch windows rather than DISTINCT ON + join).
-- The contract requires them to agree; a test asserts it for every item. Two
-- independent derivations of one number is the point — if they ever disagree,
-- one of the two folds is wrong.
CREATE OR REPLACE VIEW item_since_last_count AS
WITH count_totals AS (
  SELECT
    item_id,
    count(*) FILTER (WHERE event_type = 'StockCounted') AS counts_recorded
  FROM item_event_epochs
  GROUP BY item_id
),
last_count AS (
  SELECT DISTINCT ON (item_id)
    item_id,
    occurred_at AS last_count_at,
    counted_quantity
  FROM item_event_epochs
  WHERE event_type = 'StockCounted'
  ORDER BY item_id, sequence DESC
),
-- The trailing epoch: everything recorded after the last count. An item with
-- no count at all has counts_recorded = 0, and its whole history sits in epoch
-- 0 — so the never-counted case folds from 0 over all events, for free.
tail AS (
  SELECT
    e.item_id,
    coalesce(sum(e.delta) FILTER (WHERE e.event_type = 'StockReceived'), 0)    AS received,
    coalesce(-sum(e.delta) FILTER (WHERE e.reason = 'sale'), 0)                AS depleted_sale,
    coalesce(-sum(e.delta) FILTER (WHERE e.reason = 'waste'), 0)               AS depleted_waste,
    coalesce(-sum(e.delta) FILTER (WHERE e.reason = 'sample'), 0)              AS depleted_sample,
    coalesce(sum(e.delta), 0)                                                  AS delta
  FROM item_event_epochs e
  JOIN count_totals t ON t.item_id = e.item_id AND e.epoch = t.counts_recorded
  GROUP BY e.item_id
)
SELECT
  t.item_id,
  t.counts_recorded,
  lc.last_count_at,
  coalesce(tail.received, 0)::bigint        AS received,
  coalesce(tail.depleted_sale, 0)::bigint   AS depleted_sale,
  coalesce(tail.depleted_waste, 0)::bigint  AS depleted_waste,
  coalesce(tail.depleted_sample, 0)::bigint AS depleted_sample,
  (coalesce(lc.counted_quantity, 0) + coalesce(tail.delta, 0))::bigint AS expected_quantity
FROM count_totals t
LEFT JOIN last_count lc ON lc.item_id = t.item_id
LEFT JOIN tail        ON tail.item_id = t.item_id;
