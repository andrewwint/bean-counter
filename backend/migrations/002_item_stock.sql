-- 002_item_stock.sql — the read model.
--
-- This view is the centerpiece of the project: it is the whole "how much do we
-- have?" question, expressed as a fold over the log. Read it top to bottom.
--
-- The rule (from docs/architecture/slice-1-contract.md):
--
--   qty(item) = coalesce(last StockCounted.countedQuantity, 0)
--             + sum(StockReceived.quantity  where sequence > that count's sequence)
--             - sum(StockDepleted.quantity  where sequence > that count's sequence)
--
-- A physical count is an ABSOLUTE RESET, not a delta: it wins over everything
-- the log said before it, and only deltas recorded *after* it still apply. An
-- item that has never been counted folds from 0 over its entire history.
--
-- The gap between "what the log predicted" and "what the last count found" is
-- shrinkage. We deliberately do not hide it — see the seed data.

CREATE MATERIALIZED VIEW IF NOT EXISTS item_stock AS

-- The item's identity. An item may be redefined (renamed, recategorised);
-- the most recent ItemDefined wins. Only defined items appear on the board.
WITH defined AS (
  SELECT DISTINCT ON (stream_id)
    stream_id            AS item_id,
    payload ->> 'name'      AS name,
    payload ->> 'category'  AS category,
    payload ->> 'baseUnit'  AS base_unit
  FROM events
  WHERE event_type = 'ItemDefined'
  ORDER BY stream_id, sequence DESC
),

-- The baseline: each item's most recent physical count, and where in the
-- global order it sits. Items with no count simply have no row here.
last_count AS (
  SELECT DISTINCT ON (stream_id)
    stream_id                             AS item_id,
    sequence                              AS counted_at_sequence,
    (payload ->> 'countedQuantity')::bigint AS counted_quantity
  FROM events
  WHERE event_type = 'StockCounted'
  ORDER BY stream_id, sequence DESC
),

-- Everything that moved after the baseline. `coalesce(..., 0)` is what makes
-- the never-counted case fold over all events: sequence > 0 is every row.
-- Quantities are integers in a base unit, so this sum is exact — no float drift.
deltas AS (
  SELECT
    e.stream_id AS item_id,
    sum(
      CASE e.event_type
        WHEN 'StockReceived' THEN  (e.payload ->> 'quantity')::bigint
        WHEN 'StockDepleted' THEN -(e.payload ->> 'quantity')::bigint
        ELSE 0
      END
    ) AS delta
  FROM events e
  LEFT JOIN last_count c ON c.item_id = e.stream_id
  WHERE e.sequence > coalesce(c.counted_at_sequence, 0)
  GROUP BY e.stream_id
),

-- When the shop last touched this item (occurred_at, not recorded_at: the
-- board shows shop time, not clerk-typing time).
last_event AS (
  SELECT stream_id AS item_id, max(occurred_at) AS last_event_at
  FROM events
  GROUP BY stream_id
)

SELECT
  d.item_id,
  d.name,
  d.category,
  d.base_unit,
  (coalesce(c.counted_quantity, 0) + coalesce(dl.delta, 0))::bigint AS quantity,
  le.last_event_at
FROM defined d
LEFT JOIN last_count c  ON c.item_id  = d.item_id
LEFT JOIN deltas     dl ON dl.item_id = d.item_id
LEFT JOIN last_event le ON le.item_id = d.item_id;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index on the view.
CREATE UNIQUE INDEX IF NOT EXISTS item_stock_item_id_idx ON item_stock (item_id);
