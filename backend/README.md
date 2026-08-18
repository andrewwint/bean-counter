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
src/export-readmodel.ts         CSV handoff to the analytics lane
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
| `npm run export:csv` | dump `item_stock` for the analytics lane |

## Analytics handoff

`npm run export:csv` writes `analytics/data/item_stock.csv` at the repo root
(override with `EXPORT_PATH`). That directory is owned by the analytics lane —
this service writes into it but never creates it. The equivalent by hand:

```sql
\copy (SELECT item_id, name, category, base_unit, quantity, last_event_at
         FROM item_stock ORDER BY category, name)
  TO 'analytics/data/item_stock.csv' WITH (FORMAT csv, HEADER true)
```

## Slice-1 simplifications (deliberate, marked in code)

- `REFRESH MATERIALIZED VIEW CONCURRENTLY item_stock` runs **synchronously**
  after every successful append. Correct and obvious; a later slice swaps in an
  incremental projection table.
- **No authentication** on `POST /api/events`. The place it would attach is
  marked in `src/routes/events.ts`; that boundary is under separate review. Do
  not expose this service beyond localhost until it lands.
