## 1. Schema
- [ ] 1.1 Migration: create `item_stock` as a table with `last_event_sequence` and `last_event_at`
- [ ] 1.2 Migration: drop the `item_stock` materialized view (same migration, so the name never collides)
- [ ] 1.3 Populate the new table from the log as part of the migration

## 2. Write path
- [ ] 2.1 Wrap the append in an explicit transaction: insert the event, then update the projection row
- [ ] 2.2 `StockReceived` / `StockDepleted` apply a delta; `StockCounted` sets the quantity absolutely
- [ ] 2.3 `ItemDefined` inserts the projection row at quantity 0
- [ ] 2.4 Take a row lock on the projection row so concurrent appends to one item serialize
- [ ] 2.5 Remove the post-append `REFRESH MATERIALIZED VIEW CONCURRENTLY` call

## 3. Rebuild and verification
- [ ] 3.1 `npm run rebuild-projection` — truncate and re-derive from the log
- [ ] 3.2 `npm run verify-projection` — re-fold the log, diff against the table, exit non-zero on drift
- [ ] 3.3 Wire `verify-projection` into CI after the seed step

## 4. Tests
- [ ] 4.1 A read immediately after an append sees the new quantity (no stale window)
- [ ] 4.2 A failed append leaves both the log and the projection unchanged
- [ ] 4.3 Concurrent appends to the same item produce the same total as sequential ones
- [ ] 4.4 Rebuilding from the log reproduces the incrementally maintained table exactly
- [ ] 4.5 `GET /api/stock` returns a byte-identical shape to the materialized-view implementation
- [ ] 4.6 Full-suite run: `make test`
