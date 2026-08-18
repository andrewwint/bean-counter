# bean-counter — Slice 1 shared contract

Authoritative for all lanes. Do not redefine these shapes locally.

## Runtime
Node **v22** (`.nvmrc` = `22`). TypeScript, ESM (`"type": "module"`). Package manager: **npm**.

**Postgres 18.** Two valid local paths — code must never assume which one is live, so
`DATABASE_URL` always comes from env and no port is ever hardcoded:

| Path | Port | Notes |
| --- | --- | --- |
| Native (Homebrew `postgresql@18`) | **5432** | Live on this machine; db `bean_counter` exists; trust auth |
| Container (`docker compose`, `postgres:18`) | **5433** | Portable default for a fresh clone and for CI; 5433 because 5432 is taken |

The database is named **`bean_counter`** on both paths (role `beancounter`, tests use
`bean_counter_test`). One name everywhere: otherwise you migrate one database, inspect the other,
and read stale numbers with nothing appearing to be broken.

`psql` 18.6 is on PATH (`/usr/local/bin/psql` -> `postgresql@18/18.6`); the versioned path
`/usr/local/opt/postgresql@18/bin/psql` is the fallback. `make db-check` reports which server
the current `DATABASE_URL` actually reaches.

## Domain: base units (the drift-prevention rule)
Every quantity is stored as an **integer in a base unit**. Never floats, never mixed units in storage.

| Base unit | Stored as | Display edge |
| --- | --- | --- |
| `g`    | grams (int)       | kg for beans (12000 g -> "12 kg") |
| `ml`   | milliliters (int) | L for milk (4000 ml -> "4 L") |
| `each` | count (int)       | as-is (cups, lids) |

Conversion happens **only** in the UI formatting layer. The API speaks base units exclusively.

## Event store (Postgres, append-only)
Table `events` — never UPDATE, never DELETE.

```
sequence      bigserial primary key      -- global order
event_id      uuid not null unique
stream_id     text not null              -- the item id
event_type    text not null
event_version int  not null default 1    -- schema version; upcast on read
payload       jsonb not null
occurred_at   timestamptz not null       -- when it happened in the shop
recorded_at   timestamptz not null default now()
```
Index on `(stream_id, sequence)`.

`event_version` exists from day one. Readers switch on it. History is never rewritten.

## Event types (v1)
- `ItemDefined`    `{ itemId, name, category, baseUnit }`
- `StockReceived`  `{ itemId, quantity, supplier?, lotId? }`   quantity > 0
- `StockDepleted`  `{ itemId, quantity, reason: "sale"|"waste"|"sample" }`  quantity > 0
- `StockCounted`   `{ itemId, countedQuantity }`  absolute reset, not a delta

Every `quantity` / `countedQuantity` is also bounded **above** by `9007199254740991`
(`Number.MAX_SAFE_INTEGER`) — enforced by zod and again by a CHECK on `events`. An unbounded
integer is not merely a bad row: it overflows the `::bigint` cast in the fold, and since the log
is append-only there is no way to remove it. String fields are trimmed and must be non-empty
after trimming.

## Read model: `item_stock` MATERIALIZED VIEW
Current quantity = the last physical count, plus every delta recorded after it.

```
qty(item) = coalesce(last StockCounted.countedQuantity, 0)
          + sum(StockReceived.quantity  where sequence > that count's sequence)
          - sum(StockDepleted.quantity  where sequence > that count's sequence)
```
Items with no `StockCounted` fold from 0 over all events.
Refreshed after each append, **inside the append's transaction** — a plain
`REFRESH MATERIALIZED VIEW item_stock`, not `CONCURRENTLY`, because Postgres forbids the
concurrent form inside a transaction block. So a refresh failure rolls the event back and the
client's `500` truthfully means nothing happened. The price is an `ACCESS EXCLUSIVE` lock for
the duration of the refresh: readers block and concurrent appends serialise. Acceptable at a
coffee shop's volume, and it is the projection table (`add-projection-table`) that removes the
cost, not a looser response contract.

## HTTP API (backend, port 3000, prefix `/api`)
| Method | Path | Body / Result |
| --- | --- | --- |
| GET  | `/api/health` | `{ status: "ok", db: true }` |
| POST | `/api/events` | body `{ type, eventId?, occurredAt?, ...payload }` -> `201 { eventId, sequence }`; `200` on replay |
| GET  | `/api/stock`  | `200 [{ itemId, name, category, baseUnit, quantity, lastEventAt }]` |
| GET  | `/api/items/:itemId/history` | `200 [{ sequence, eventType, payload, occurredAt }]` |

`eventId` is the **idempotency handle**. A client that retries a request it never saw the
answer to may name the fact it already sent; naming it twice records it once. Absent, the id is
generated server-side (what the frontend does today). A replay returns the **original** event's
`{ eventId, sequence }` with `200` — identical body, different status, because `201 Created`
would claim this request created something and it did not. Reusing an `eventId` for a
materially different fact (different type, stream, or payload) is `409 EVENT_ID_CONFLICT`, not
a silent replay: swallowing a real second delivery is the one failure an inventory log must not
have. `occurredAt` is excluded from that comparison because it defaults to `now()` when omitted,
so an honest retry of the same body carries a new timestamp; first write wins.

Errors: `400 { error: { code, message, details? } }`. Validation with **zod**; an invalid
event is rejected before it reaches the log (the log only ever holds valid history). A malformed
`eventId` is `400 INVALID_EVENT` like any other bad field.
CORS: allow `http://localhost:5173` in dev only.

## Frontend (Vite + React + TS, port 5173)
Reads `GET /api/stock`, renders the "stock board" (the chalkboard analogy).
Writes via `POST /api/events` — a receive-stock form and a record-waste form.
API base URL from `VITE_API_URL`, default `http://localhost:3000`.

## Seed data
A realistic week: 3 bean origins (Yirgacheffe, Huila, Sumatra Mandheling), whole milk + oat milk,
12oz cups + lids. A busy Saturday of sales, one waste event (stale batch), one Monday count that
comes up short — so the reconciliation gap is visible on first boot.

---

## Resolved ambiguities (raised by the backend lane during slice 1)

These were genuine holes in this contract's first draft. Recorded so slice 2 does not relitigate them.

1. **`lastEventAt` means `occurred_at`, not `recorded_at`.** The board reads in *shop time* — when it
   happened behind the bar — not when a clerk got around to entering it. The frontend must not assume
   otherwise.
2. **`StockCounted.countedQuantity: 0` is legal.** "We're out of oat milk" is a real observation. The
   `> 0` rule constrains *movement* quantities (`StockReceived` / `StockDepleted`), not an absolute count.
3. **Payload schemas are `.strict()`** — unknown fields are rejected, not silently dropped. Nothing
   unvalidated ever enters the log. `__proto__` is the one key `.strict()` cannot see (assigning it
   sets a prototype instead of creating an own property, so it disappears before the unknown-key
   check runs); `validateEvent` rejects it explicitly so the rule holds without an exception.
4. **Only streams with an `ItemDefined` appear in `item_stock`.** The board needs name/category/baseUnit
   to render. A stream with movements but no definition is deliberately invisible, and a test asserts it.
5. **`sequence` has gaps** after a re-run seed (`ON CONFLICT DO NOTHING` still burns `bigserial` values).
   Harmless — `sequence` is an ordering, never a count — but do not assert contiguity.

## Known slice-1 limitations (deliberate; each has an owner in `openspec/changes/`)

| Limitation | Why it is acceptable now | Where it gets fixed |
| --- | --- | --- |
| A full `REFRESH MATERIALIZED VIEW` on every append is O(whole log) per write, and holds `ACCESS EXCLUSIVE` for its duration | Correct and legible at a coffee shop's volume; the point of slice 1 is that the view is *derived*, and atomicity beats concurrency at one till | `add-projection-table` |
| `occurredAt` is optional and defaults to `now()` | Fine for live entry; **wrong for backfill** — an omitted `occurredAt` silently skews `lastEventAt` | Make it required in slice 2 |
| No endpoint exposes the reconciliation gap | The seed makes the gap exist, but it is only discoverable by replaying history by hand — a real product hole, not a slice-1 blocker | Slice 2 (`GET /api/items/:id/reconciliation`) |
| `POST /api/events` has no auth gate | Deliberate, and under independent security review before close-out | `add-auth-and-roles` |
