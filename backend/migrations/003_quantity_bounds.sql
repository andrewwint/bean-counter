-- 003_quantity_bounds.sql — the storage boundary for quantity magnitude.
--
-- zod already bounds quantities at the HTTP boundary (src/events/schema.ts,
-- MAX_QUANTITY). This is the second line of the same defence, because getting
-- it wrong is unrecoverable: an out-of-range quantity commits happily into the
-- append-only log, and then `(payload ->> 'quantity')::bigint` in the fold
-- (002_item_stock.sql) overflows. From that moment REFRESH fails forever, every
-- later append fails with it, and there is no DELETE that could undo it —
-- `events` is append-only. So the log itself refuses the row.
--
-- The bound is 9007199254740991 (JavaScript's MAX_SAFE_INTEGER), which is far
-- inside int8 and is the largest integer that survives a JSON round trip
-- unchanged. Comparison is in `numeric`, not `bigint`, so that checking an
-- absurd value cannot itself overflow.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_quantity_in_range'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_quantity_in_range CHECK (
      payload -> 'quantity' IS NULL OR (
        jsonb_typeof(payload -> 'quantity') = 'number'
        AND (payload -> 'quantity')::numeric
              BETWEEN -9007199254740991 AND 9007199254740991
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_counted_quantity_in_range'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_counted_quantity_in_range CHECK (
      payload -> 'countedQuantity' IS NULL OR (
        jsonb_typeof(payload -> 'countedQuantity') = 'number'
        AND (payload -> 'countedQuantity')::numeric
              BETWEEN -9007199254740991 AND 9007199254740991
      )
    );
  END IF;
END
$$;
