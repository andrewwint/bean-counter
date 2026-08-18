# Change: Offline-first stock counting on a tablet, synced when wifi returns

## Why
Counting stock happens in the stockroom, and the stockroom is where the wifi is worst. Today the
count app needs a live connection to `POST /api/events`, so a manager walking the shelves either
loses the count when the signal drops or — much more likely — writes the numbers on paper and types
them in later. A count typed in an hour after it was taken is a count with a worse `occurredAt` and
a real chance of transcription error.

Offline-first fixes the actual constraint: let the tablet hold the count locally, and sync it when
the connection comes back.

## What Changes
- Add a local **SQLite** store on the counting tablet holding a queue of pending count events.
- Capture counts offline against a locally cached item list; the tablet is usable with no network.
- Sync the queue to `POST /api/events` when connectivity returns, preserving each event's
  `occurredAt` (when it was counted) distinct from `recordedAt` (when the server received it).
- Make sync **idempotent** using the client-generated `eventId` — a retry after an ambiguous failure
  must not append the count twice.
- Show the manager an explicit pending-sync state: how many counts are queued and how old they are.
- Detect and surface the conflict case: stock moved on the server between the count and the sync.
- **Non-goal, stated up front:** SQLite is not a read cache and is not a second source of truth.

## Impact
- Affected specs: `offline-counting` (new capability)
- Affected code: `frontend/` (offline count flow, local store, sync worker, pending-state UI),
  `backend/src/` (idempotent append keyed on `eventId`)
- Interacts with `add-auth-and-roles`: only a manager may record `StockCounted`, so the tablet must
  hold a manager session and must not queue counts for an unauthorized user.
