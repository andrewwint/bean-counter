## 1. Identity
- [ ] 1.1 Add a `users` table: id, display name, role, password hash (argon2id), created_at
- [ ] 1.2 Add a seed manager account; document that its password must be changed on first run
- [ ] 1.3 Session issuance on `POST /api/sessions`; httpOnly, SameSite=Lax cookie
- [ ] 1.4 Session teardown on `DELETE /api/sessions`

## 2. Attribution
- [ ] 2.1 Migration: add `actor_id` and `actor_role` to `events`, both NOT NULL for new rows
- [ ] 2.2 Backfill existing rows with a reserved `system:pre-auth` actor — appending nothing, altering no payload
- [ ] 2.3 Write the acting user onto every appended event inside the same transaction as the insert
- [ ] 2.4 Record the role **as it was at write time**, not by joining to the user's current role

## 3. Authorization
- [ ] 3.1 Reject unauthenticated writes with `401`
- [ ] 3.2 Per-event-type authorization table; default-deny for any event type not listed
- [ ] 3.3 Reject a barista's `StockCounted` with `403` before the event reaches the log
- [ ] 3.4 Require a non-empty `note` when a `StockCounted` deviates beyond the configured threshold
- [ ] 3.5 Authorize on the server only; the frontend hiding a control is not an access control

## 4. Surfacing
- [ ] 4.1 `GET /api/items/:itemId/history` returns actor display name and role per event
- [ ] 4.2 Frontend: login screen, current-user indicator, count control hidden from baristas
- [ ] 4.3 Analytics export carries `actor_id` and `actor_role` so counts are attributable in the notebook

## 5. Tests
- [ ] 5.1 A barista posting `StockCounted` gets `403` and the log length is unchanged
- [ ] 5.2 A manager posting `StockCounted` succeeds and the event carries their id and role
- [ ] 5.3 An unauthenticated write gets `401` and the log length is unchanged
- [ ] 5.4 A user promoted from barista to manager does not change the role stamped on their old events
- [ ] 5.5 An unknown event type is denied by default rather than allowed
- [ ] 5.6 Full-suite run: `make test`
