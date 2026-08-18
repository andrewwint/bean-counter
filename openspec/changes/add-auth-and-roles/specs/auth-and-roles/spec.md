## ADDED Requirements

### Requirement: Authenticated Writes
The system MUST reject any append to the event log that does not carry a valid authenticated session, and SHALL do so before the event is validated or written.

#### Scenario: An unauthenticated write is rejected
- **WHEN** `POST /api/events` is called with no session
- **THEN** the response is `401`
- **AND** no row is appended to `events`

#### Scenario: An expired session is rejected
- **WHEN** `POST /api/events` is called with a session that has expired
- **THEN** the response is `401`
- **AND** no row is appended to `events`

### Requirement: Every Event Is Attributed
The system SHALL stamp every appended event with the acting user's id and the role that user held at the moment of writing, in the same transaction as the insert.

#### Scenario: An accepted event carries its actor
- **WHEN** a manager appends a `StockReceived` event
- **THEN** the stored row carries that manager's `actor_id` and `actor_role: "manager"`

#### Scenario: A later role change does not rewrite history
- **GIVEN** a barista appended a `StockDepleted` event while holding the barista role
- **WHEN** that user is later promoted to manager
- **THEN** the earlier event still reads `actor_role: "barista"`

### Requirement: Role-Based Event Authorization
The system MUST authorize each append against the acting user's role using an explicit per-event-type policy, and SHALL deny by default any event type the policy does not name.

#### Scenario: A barista records the ordinary shop day
- **WHEN** a barista appends `StockReceived`, `StockDepleted`, or `ProductSold`
- **THEN** the event is accepted

#### Scenario: An unrecognised event type is denied
- **WHEN** an authenticated user appends an event type absent from the authorization policy
- **THEN** the response is `403`
- **AND** no row is appended to `events`

#### Scenario: Authorization is enforced on the server
- **WHEN** a barista bypasses the frontend and posts directly to `POST /api/events`
- **THEN** the same role policy applies and the request is rejected on the server

### Requirement: Only A Manager May Record A Physical Count
The system MUST restrict `StockCounted` to users holding the manager role, because that event is an absolute reset that closes a shrinkage gap without producing a discrepancy.

#### Scenario: A barista is refused a count
- **WHEN** a barista appends a `StockCounted` event
- **THEN** the response is `403`
- **AND** no row is appended to `events`
- **AND** the read model's quantity for that item is unchanged

#### Scenario: A manager records a count
- **WHEN** a manager appends a `StockCounted` event
- **THEN** the event is accepted and attributed to that manager
- **AND** the read model folds forward from the counted quantity

### Requirement: A Large Adjustment Requires A Stated Reason
The system SHALL require a non-empty `note` on any `StockCounted` whose counted quantity deviates from the folded expected quantity by more than the configured threshold.

#### Scenario: A large unexplained count is refused
- **GIVEN** the fold expects 12000 g of beans and the deviation threshold is 5%
- **WHEN** a manager appends `StockCounted` with `countedQuantity: 9000` and no note
- **THEN** the response is `400` and no row is appended to `events`

#### Scenario: A large explained count is accepted and preserved
- **GIVEN** the same expectation and threshold
- **WHEN** a manager appends `StockCounted` with `countedQuantity: 9000` and a note reading "3 kg dumped, water damage from the ceiling leak"
- **THEN** the event is accepted
- **AND** the note is stored in the payload and is visible in the item's history

#### Scenario: A small correction needs no note
- **WHEN** a manager appends a count deviating less than the threshold
- **THEN** the event is accepted without a note

### Requirement: History Shows Who Acted
The system SHALL return the acting user's display name and role alongside every event on the item history endpoint, so an adjustment is attributable without a separate lookup.

#### Scenario: A count is attributable on sight
- **WHEN** `GET /api/items/beans/history` is requested
- **THEN** each entry includes the actor's display name and the role held at write time
- **AND** `StockCounted` entries include the stated note when one was required
