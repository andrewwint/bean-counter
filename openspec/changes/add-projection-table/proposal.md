# Change: Replace the materialized view with an in-transaction projection table

## Why
Slice 1 refreshes `item_stock` with `REFRESH MATERIALIZED VIEW CONCURRENTLY` after every append. That
works and was the right call for a first slice, but it re-folds the **entire** log on every single
event. Cost grows with total history, not with the change just made — so the system gets slower every
day it is used, purely as a function of having been used. A busy Saturday makes Monday slower.

It also leaves a window: the refresh happens after the insert commits, so a read landing in between
sees a stock number that is stale by one event. The fix is to make the projection part of the same
transaction as the append.

## What Changes
- Add an ordinary `item_stock` **table** (id, quantity, last_event_sequence, last_event_at).
- Apply each event's delta to the projection row **inside the same transaction as the insert** — an
  incremental update, not a re-fold.
- Handle `StockCounted` as an absolute set of the quantity, matching the contract's fold semantics.
- Add a `rebuild-projection` command that drops and re-derives the whole table from the log.
- Add a `verify-projection` check that re-folds the log and asserts the projection agrees — a drift
  detector, runnable in CI and after any incident.
- **Remove** the materialized view and the post-append `REFRESH`.
- No change to `GET /api/stock`'s response shape. The read model was never the source of truth, so
  this swap is invisible from outside.

## Impact
- Affected specs: `stock-read-model`
- Affected code: `backend/migrations/` (drop the view, create the table),
  `backend/src/` (the append path becomes insert + projection update in one transaction),
  `analytics/` (export reads a table instead of a view; same columns)
- Not affected: the `events` table, event payloads, the HTTP contract, the frontend.
