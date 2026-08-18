# bean-counter backend

An append-only Postgres event log plus the read model folded from it. Hono, `pg`
with plain SQL, zod at the boundary, vitest against a real database.

## The two rules

1. **`events` is append-only.** No UPDATE, no DELETE anywhere in `src/`. A
   mistake is corrected by appending a correcting event — usually a
   `StockCounted`, which is an absolute reset of what is actually on the shelf.
2. **Every quantity is an integer in a base unit** (`g` / `ml` / `each`). Floats
   and zero/negative movements are rejected by zod *before* the append, so the
   log only ever contains valid history. Unit prettifying is a UI concern.

## Layout

```
migrations/001_events.sql       the log
migrations/002_item_stock.sql   the fold — the centrepiece; read this one
src/migrate.ts                  numbered-SQL runner, tracked in schema_migrations
src/db.ts                       the pool (DATABASE_URL from env)
src/events/schema.ts            zod schemas, event_version, upcast seam
src/events/append.ts            the only INSERT into events
src/readmodel/stock.ts          stock board + item history queries, view refresh
src/routes/                     health, events, stock
src/seed.ts                     one realistic week, idempotent
```

## Database

`DATABASE_URL` comes from the environment; no port and no credential is
hardcoded. Both are valid depending on what the developer is running:

| Path | Port |
| --- | --- |
| Native Homebrew `postgresql@18` | 5432 |
| `docker compose up -d postgres` (`postgres:18`) | 5433 |

Copy `.env.example` and adjust. Tests use a **separate** database selected by
`DATABASE_URL_TEST` (default `postgresql://localhost:5432/bean_counter_test`),
created and dropped by `test/global-setup.ts` so the suite never truncates dev
data. `KEEP_TEST_DB=1` keeps it around for inspection.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | watch-mode server on `PORT` (default 3000) |
| `npm run build` | `tsc` to `dist/` |
| `npm start` | run the build |
| `npm test` | vitest against real Postgres |
| `npm run lint` | eslint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | apply pending SQL migrations (idempotent) |
| `npm run seed` | seed the week (idempotent) |

## Analytics handoff

The backend does not export anything. The analytics lane reads the database
itself: `make analytics-export` runs `analytics/scripts/export.py`, which writes
`analytics/data/*.parquet` — the only format the notebook consumes. A second,
CSV-shaped handoff used to live here (`npm run export:csv`); nothing read it, so
it was removed rather than maintained alongside the one that is real.

## The write path

`POST /api/events` appends and refreshes the read model in **one transaction on
one connection**. If the refresh fails, the event rolls back — so a `500` means
nothing happened, and the answer the client gets can never contradict the log.
The refresh inside that transaction is a plain `REFRESH MATERIALIZED VIEW`, not
`CONCURRENTLY`, because Postgres forbids the concurrent form inside a
transaction block; the cost is an `ACCESS EXCLUSIVE` lock for the refresh, which
blocks board readers and serialises concurrent appends. At one till that is the
right trade against a response that says "written, but the board may be stale".

### Idempotent retry

The body takes an optional `eventId` (UUID). It is the handle a client uses to
say *this is the same fact I already sent* — a barista whose "received 12 kg"
appears to fail presses it again, and an append-only log would otherwise hold
24 kg forever.

| Case | Answer |
| --- | --- |
| No `eventId` | id generated server-side, `201` (unchanged; the frontend sends none) |
| New `eventId` | appended, `201 { eventId, sequence }` |
| Replayed `eventId`, same fact | `200` with the **original** `{ eventId, sequence }` — same body shape |
| Replayed `eventId`, different fact | `409 { error: { code: "EVENT_ID_CONFLICT", … } }` |
| Malformed `eventId` | `400 INVALID_EVENT` |

Deduplication is the `UNIQUE` index on `event_id` (`INSERT … ON CONFLICT DO
NOTHING`), never a read-then-write check: retries arrive in parallel and only
the index can arbitrate. `test/idempotency.test.ts` fires eight at once and
asserts one row and one shared `sequence`.

`occurredAt` is not part of the "same fact" comparison — it defaults to `now()`
when omitted, so an honest retry of the same body carries a new timestamp. First
write wins.

## Slice-1 simplifications (deliberate, marked in code)

- The read model is re-folded **synchronously on every append** (O(whole log)).
  Correct and obvious; a later slice swaps in an incremental projection table.
- **No authentication** on `POST /api/events`. The place it would attach is
  marked in `src/routes/events.ts`; that boundary is under separate review. Do
  not expose this service beyond localhost until it lands.
