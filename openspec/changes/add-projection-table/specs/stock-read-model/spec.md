## ADDED Requirements

### Requirement: Projection Updated In The Append Transaction
The system MUST update the `item_stock` projection inside the same database transaction that appends the event, so that no committed state exists in which the log and the projection disagree.

#### Scenario: A read immediately after a write is current
- **WHEN** `POST /api/events` returns `201` for a `StockReceived` of 1000 g
- **AND** `GET /api/stock` is called immediately afterwards
- **THEN** the returned quantity already includes the 1000 g

#### Scenario: A failed append leaves nothing behind
- **GIVEN** the projection update fails
- **WHEN** the transaction rolls back
- **THEN** the event is not present in `events`
- **AND** the projection row is unchanged

### Requirement: Incremental Application Of Each Event
The system SHALL apply each event to the projection incrementally rather than re-folding the log, applying `StockReceived` and `StockDepleted` as deltas and `StockCounted` as an absolute set of the quantity.

#### Scenario: A delta event moves the projection by its own quantity
- **GIVEN** beans stand at 12000 g
- **WHEN** a `StockDepleted` of 250 g is appended
- **THEN** the projection reads 11750 g
- **AND** no other item's row is touched

#### Scenario: A count sets the quantity absolutely
- **GIVEN** the projection expects 11750 g of beans
- **WHEN** a `StockCounted` of 11200 g is appended
- **THEN** the projection reads 11200 g, not 23000 g

#### Scenario: Appending does not scan the whole log
- **WHEN** an event is appended to an item with a long history
- **THEN** the projection update reads only that item's projection row

### Requirement: Projection Is Rebuildable From The Log
The system SHALL provide a command that discards the projection entirely and re-derives it from the event log, producing a result identical to the incrementally maintained table.

#### Scenario: A rebuild reproduces the maintained state
- **GIVEN** a projection maintained incrementally across a seeded week of events
- **WHEN** the projection is dropped and rebuilt from the log
- **THEN** every item's quantity and `last_event_sequence` match the pre-rebuild values

#### Scenario: The log survives the projection
- **WHEN** the projection table is truncated
- **THEN** the `events` table is unchanged
- **AND** a rebuild restores the read model with no loss

### Requirement: Drift Detection
The system SHALL provide a verification command that re-folds the event log independently and fails when the projection disagrees with that fold.

#### Scenario: Drift is reported
- **GIVEN** a projection row has been altered out of band to a wrong quantity
- **WHEN** the verification command runs
- **THEN** it exits non-zero and names the item, the projected quantity, and the folded quantity

#### Scenario: A healthy projection verifies clean
- **WHEN** the verification command runs against a projection maintained by the append path
- **THEN** it exits zero and reports no differences

### Requirement: Unchanged Read Contract
The system MUST keep the `GET /api/stock` response shape unchanged by this swap, since the read model is a derived artifact and not the source of truth.

#### Scenario: Clients notice nothing
- **GIVEN** a client written against the materialized-view implementation
- **WHEN** the projection table replaces the view
- **THEN** `GET /api/stock` returns the same fields with the same types and the client requires no change
