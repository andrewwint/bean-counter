## Context

Slice 1 shipped `item_stock` as a materialized view refreshed after every append. This proposal
replaces it with an ordinary table maintained incrementally inside the append transaction.

The interesting thing about this change is how **cheap** it is, and the reason is worth writing down
because it is the payoff for a decision made on day one: **the read model was never the source of
truth.** `item_stock` holds no information that is not already in `events`. It is a cache with a
formula. Swapping it out is not a data migration in any meaningful sense — it is deleting one
derivation and writing another, then re-deriving from a log that never changed.

Compare the alternative history, where `item_stock` was the real table and events were an audit trail
bolted on beside it. In that world this change is a data migration with reconciliation, a dual-write
period, and an unanswerable question about which store to believe when they disagree. Here, the log
is the answer by construction, and the worst failure mode is "rebuild it."

## Goals / Non-Goals

**Goals**
- Append cost proportional to the event, not to the length of history.
- No committed state in which the log and the read model disagree.
- A rebuild path and a drift detector, so the projection is provably a function of the log.

**Non-Goals**
- Async projection, a queue, a worker, or eventual consistency. One database, one transaction.
- Changing the fold's semantics. The formula in the contract is unchanged; only *when* it is applied.
- Changing the API. If a client can tell this happened, the change is wrong.

## Decisions

### Decision 1: an ordinary table updated in-transaction, not an async projector

**Alternatives considered:**

- *Keep the materialized view, refresh less often.* Cheapest to do, and wrong: it trades correctness
  for cost. Stock would be visibly stale, which in an inventory system means a barista sees beans
  that are not there.
- *Async projector reading a change feed.* The textbook CQRS answer, and correct at a scale this
  project does not have. It buys write throughput and costs a whole class of bugs — replay, ordering,
  at-least-once delivery, and a "why is the board 20 seconds behind" question in the shop. Rejected
  by the project's own "boring, proven patterns" rule.
- **Chosen:** same transaction. Postgres already gives atomicity across the two writes for free. There
  is no consistency problem to solve because there is no second store.

### Decision 2: `StockCounted` sets, it does not add

Direct consequence of the contract: a count is an absolute reset, not a delta. The incremental
update must special-case it. Getting this wrong is the obvious bug in this change — an implementation
that adds `countedQuantity` to the running total produces a plausible-looking number that is roughly
double, and no test that only exercises receive/deplete will catch it. Task 4.x names it explicitly.

### Decision 3: row-lock the projection row for the duration of the append

Two concurrent appends to the same item must not read-modify-write over each other. `SELECT ... FOR
UPDATE` on the projection row inside the transaction serializes them per item, which is exactly the
granularity needed — two different items never contend.

### Decision 4: ship the verifier with the change, not after it

An incrementally maintained cache can drift; that is its nature. A projection whose agreement with
the log is *asserted in CI* is a cache you can trust. Shipping the rebuild without the verifier would
leave the system unable to answer "is it right now?" — only "make it right again."

## Risks / Trade-offs

- **Silent drift** from a bug in the incremental path. → `verify-projection` in CI, plus the rebuild
  command as the remedy. Cost of being wrong is bounded at "re-derive from the log."
- **The `StockCounted` set/add bug.** → Named in the spec and in the task list, with a scenario that
  fails loudly (11200 vs 23000).
- **Write latency now includes the projection update.** Real, but it replaces a full-log refresh, so
  the change is a large net reduction at any history length past trivial.
- **Lock contention on a hot item** during a rush of sales for the same product. → Per-row, short,
  and held only for the append; acceptable at one shop's volume. Revisit if it ever shows up.

## Migration Plan

1. One migration: create the table, populate it from the log, drop the materialized view. Doing this
   in a single migration means the name `item_stock` never refers to two things at once, and readers
   see one or the other, never neither.
2. Switch the append path to insert-plus-update in a transaction and delete the `REFRESH` call.
3. Run `verify-projection` against the seeded week; wire it into CI.

**Rollback:** re-create the materialized view from the log and restore the `REFRESH` call. Nothing is
lost, because nothing derived was ever unique. This is the same property that made the change cheap.

## Open Questions

- Should `verify-projection` run on a schedule in a deployed environment, or only in CI? Nothing is
  deployed yet, so this is deferred to whenever `infra/` stops being a skeleton.
- Does the projection need a `version` column for optimistic concurrency, or is the row lock enough?
  The row lock is enough for a single-writer API; revisit if the append path is ever horizontally
  scaled.
