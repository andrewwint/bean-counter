## ADDED Requirements

### Requirement: Counting Works With No Network
The system SHALL allow a manager to complete a full stock count on the tablet with no network connectivity, storing each count locally until it can be synced.

#### Scenario: A count is taken in the stockroom with no signal
- **GIVEN** the tablet has no network connection
- **WHEN** the manager records counts for six items
- **THEN** all six are stored locally and shown as pending sync
- **AND** no data is lost

#### Scenario: The item list renders offline
- **GIVEN** the tablet has previously synced the item list
- **WHEN** the count screen is opened with no network
- **THEN** the cached items are listed with their names and base units

#### Scenario: A fractional quantity is refused at capture
- **WHEN** the manager enters `11.5` for an item measured in grams
- **THEN** the entry is refused on the tablet before it is queued

### Requirement: Capture Time Is Preserved Through Sync
The system MUST preserve the moment a count was taken as the event's `occurredAt`, independent of when the server receives it, so that the fold orders the count by when it happened in the shop.

#### Scenario: A count synced an hour later keeps its capture time
- **GIVEN** a count captured at 08:15 with no connectivity
- **WHEN** it syncs at 09:20
- **THEN** the appended event carries `occurredAt` of 08:15
- **AND** `recordedAt` reflects 09:20

### Requirement: Sync Is Idempotent
The system MUST append a queued count at most once, keyed on the client-generated `eventId`, so that a retry after an ambiguous failure cannot double-record a count.

#### Scenario: An ambiguous timeout is retried safely
- **GIVEN** the tablet posts a queued count and the response is lost to a timeout after the server committed it
- **WHEN** the tablet retries the same `eventId`
- **THEN** the server responds as a success without appending a second row
- **AND** the log contains exactly one event with that `eventId`

#### Scenario: A queued row is cleared only on confirmation
- **WHEN** a sync attempt fails with a network error
- **THEN** the row remains in the local queue with its error recorded
- **AND** it is retried on the next connectivity return

#### Scenario: The queue survives a restart
- **GIVEN** counts are pending sync
- **WHEN** the tablet app is closed and reopened
- **THEN** the pending counts are still queued

### Requirement: Pending State Is Visible
The system SHALL show the manager how many counts are awaiting sync and how old the oldest one is, so an unsynced count is never mistaken for a recorded one.

#### Scenario: Pending counts are shown
- **GIVEN** three counts captured 40 minutes ago have not synced
- **WHEN** the manager opens the tablet
- **THEN** the pending count and the age of the oldest are displayed

#### Scenario: An unrecoverable sync failure is surfaced
- **WHEN** a queued count is rejected with `403` because the session lacks the manager role
- **THEN** the failure is shown to the user and the row stops being retried silently

### Requirement: Intervening Stock Movement Is Surfaced, Not Resolved
The system SHALL detect when stock for a counted item moved on the server between capture and sync, append the count regardless, and report the intervening events to the manager without auto-resolving the discrepancy.

#### Scenario: Beans were used between the count and the sync
- **GIVEN** beans were counted at 08:15 while the tablet was offline
- **AND** a `StockDepleted` of 250 g was recorded on the server at 08:40
- **WHEN** the count syncs at 09:20
- **THEN** the count is appended with `occurredAt` of 08:15
- **AND** the manager is shown that 250 g of depletion was recorded between capture and sync

### Requirement: The Local Store Is A Queue, Not A Source Of Truth
The system MUST treat the tablet's SQLite database strictly as an outbound queue plus a display cache, and SHALL NOT derive any authoritative stock quantity from it.

#### Scenario: The server remains authoritative
- **WHEN** the tablet's local data disagrees with the server's read model after a successful sync
- **THEN** the tablet adopts the server's values

#### Scenario: Losing the tablet loses no confirmed history
- **GIVEN** every queued count has synced successfully
- **WHEN** the tablet's local database is deleted
- **THEN** no event is lost from the system of record
