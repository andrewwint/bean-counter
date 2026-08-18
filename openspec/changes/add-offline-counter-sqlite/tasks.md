## 1. Local store
- [ ] 1.1 SQLite schema: `pending_events` (event_id, type, payload, occurred_at, attempts, last_error)
- [ ] 1.2 Cache the item list locally so the count screen renders offline
- [ ] 1.3 Generate the `eventId` (uuid) on the tablet at capture time, not at sync time

## 2. Capture
- [ ] 2.1 Count screen works with the network fully unavailable
- [ ] 2.2 Stamp `occurredAt` at capture, from the tablet clock
- [ ] 2.3 Enforce base-unit integers at capture; a fractional entry is refused on the tablet
- [ ] 2.4 Show queued count and age of the oldest pending item

## 3. Sync
- [ ] 3.1 Detect connectivity return and drain the queue oldest-first
- [ ] 3.2 Retry with backoff; keep the row and record `last_error` on failure
- [ ] 3.3 Remove a row from the queue only after a confirmed `201` or a confirmed duplicate
- [ ] 3.4 Backend: treat a repeat `eventId` as an idempotent success rather than a unique-violation error
- [ ] 3.5 Surface a sync failure that will not resolve (e.g. `403`) to the user rather than retrying forever

## 4. Conflict surfacing
- [ ] 4.1 Compare the server's `sequence` at sync time against the item's last-known sequence at capture
- [ ] 4.2 Warn when stock moved between capture and sync, showing both the count and the intervening events
- [ ] 4.3 Do not auto-resolve; the count is still appended and the manager is told what changed

## 5. Tests
- [ ] 5.1 A count captured offline appears in the log after connectivity returns
- [ ] 5.2 `occurredAt` reflects capture time, `recordedAt` reflects server receipt, and they differ
- [ ] 5.3 A sync retried after an ambiguous timeout appends exactly one event
- [ ] 5.4 The tablet's queue survives an app restart
- [ ] 5.5 A queued count from an unauthorized user is rejected and surfaced, not silently dropped
- [ ] 5.6 Full-suite run: `make test`
