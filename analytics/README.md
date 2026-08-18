# analytics — where did the coffee go?

Python analysis over the bean-counter event log. One notebook so far:
[`notebooks/01-shrinkage.ipynb`](notebooks/01-shrinkage.ipynb) — folds the log forward into the stock
the shop *should* have, sets that against what someone actually counted on the shelf, and works
through what plausibly explains the gap.

## Quick start

```bash
cd analytics
make notebook        # installs deps, generates sample data if needed, opens Jupyter
```

That works on a fresh clone with no database running and nothing seeded. If you would rather just
check that it all executes:

```bash
make execute         # runs the notebook top-to-bottom, fails on any error
```

## The read path

**The notebook reads an exported snapshot from `analytics/data/`. It does not connect to the
application database.**

This is a deliberate design decision, not an accident of convenience. A notebook holding live
database credentials is a habit that graduates into production: notebooks get emailed, committed,
copied onto laptops, and eventually run against the real database by someone who believed they were
pointed at staging — and the connection they hold is one no application code path audits or rate
limits. Keeping analysis on a batch-exported snapshot means the credential lives in exactly one
place (`scripts/export.py`, which runs as a job), and the notebook itself carries nothing worth
stealing.

So the flow is:

```
Postgres  --(make analytics-export, batch)-->  analytics/data/*.parquet  -->  the notebook
```

There is an opt-in direct-to-database path for the rare case where you genuinely need one. It is
gated behind `BEANCOUNTER_ANALYTICS_ALLOW_DB=1`, it prints a warning when it activates, and it needs
the optional `db` extra (`make install-db`). Use it knowingly or not at all — and never commit a
notebook whose saved output came from live data.

## Getting data

| You want | Run | Needs a database |
| --- | --- | --- |
| Sample data to explore or review the notebook | `make fixtures` | no |
| The real shop's data | `make analytics-export` (from the repo root) | yes |

`make fixtures` writes a deterministic sample week — three bean origins, two milks, cups and lids; a
mid-week delivery, a busy Saturday, one stale batch binned on Sunday, and a Monday count that comes
up short. The shortfall is planted on purpose and is sized like the real thing (a fraction of a gram
per espresso shot, a couple of percent of the milk poured), so the notebook has something honest to
find. Same input, same bytes out, every time.

The item ids, names and categories are exactly the ones `backend/src/seed.ts` writes — the
vocabulary is defined once, in [`scripts/schema.py`](scripts/schema.py), and both the fixtures and
the notebook use it, so a section cannot quietly select on a word the real data does not use. The
quantities are *not* the seed's: this is a fuller week, and it carries one deliberately
never-counted item (a 16oz cup that arrived mid-week) so that the notebook's cross-check against the
read model covers the contract's fold-from-zero case on a clean checkout.

The snapshot is a generated artifact and is gitignored — the generator is what's committed. Anything
that needs the data rebuilds it automatically, so you should never have to think about this.

## Snapshot schema

Both the fixture generator and the live export write these two files, and the column set is defined
in one place — [`scripts/schema.py`](scripts/schema.py) — so the two cannot drift apart. **A backend
export can slot straight in by writing the same columns.**

### `data/events.parquet` — the append-only log, flattened

The jsonb payload is split into typed columns; a column is null where that event type does not carry
the field. Quantities are integers in a base unit (`g` / `ml` / `each`), exactly as stored.

| Column | Type | Notes |
| --- | --- | --- |
| `sequence` | int64 | global order — the fold reads this |
| `event_id` | string | uuid |
| `item_id` | string | `stream_id` in the log |
| `event_type` | string | `ItemDefined` / `StockReceived` / `StockDepleted` / `StockCounted` |
| `event_version` | int32 | readers switch on it; only v1 exists today |
| `quantity` | Int64, nullable | `StockReceived` / `StockDepleted` |
| `counted_quantity` | Int64, nullable | `StockCounted` — an absolute reset, not a delta |
| `reason` | string, nullable | `StockDepleted`: `sale` / `waste` / `sample` |
| `supplier`, `lot_id` | string, nullable | `StockReceived`, optional |
| `name`, `category`, `base_unit` | string, nullable | `ItemDefined` only |
| `occurred_at` | timestamp, UTC | when it happened in the shop |
| `recorded_at` | timestamp, UTC | when the system heard about it |

### `data/stock.parquet` — the read model (`item_stock`) as of the export

| Column | Type |
| --- | --- |
| `item_id` | string |
| `name` | string |
| `category` | string |
| `base_unit` | string |
| `quantity` | int64 |
| `last_event_at` | timestamp, UTC |

This file is strictly derived — it holds nothing that could not be recomputed from
`events.parquet`. The notebook recomputes it anyway and asserts the two agree, because if its fold
disagrees with the application's, every number further down is worthless.

## Why the analysis needs the event log at all

`stock.parquet` alone cannot answer "where did the coffee go", and the reason is worth understanding
before reading the notebook.

A `StockCounted` event is an **absolute reset**. The moment someone counts the shelf, the read model
adopts that number and the disagreement that prompted the count disappears from it. The shrinkage is
therefore never visible in current stock — it lives in the window *between two counts*, and you can
only see it by replaying every event in that window:

```
expected_at_count = previous count + received in between - depleted in between
variance          = counted - expected_at_count
```

That replay is the one thing an append-only log gives you and a mutable `quantity` column cannot.

## Targets

Run from `analytics/` (the repo-root Makefile delegates `analytics-export` and `notebook` here).

| Target | What it does |
| --- | --- |
| `make install` | Create the venv and install dependencies |
| `make install-db` | Add the optional `psycopg` extra — only needed for `make export` |
| `make fixtures` | Regenerate the sample snapshot in `data/` (no database) |
| `make export` | Export the live read model + event log to `data/*.parquet` (needs `DATABASE_URL`) |
| `make notebook` | Launch Jupyter on the shrinkage notebook |
| `make execute` | Run the notebook top-to-bottom and fail on any error — the CI check |
| `make clean` | Remove the venv, caches, and the generated snapshot |

## Dependencies

Managed with [uv](https://docs.astral.sh/uv/); Python is pinned in `.python-version`.

pandas, pyarrow, matplotlib, jupyter, duckdb, python-dotenv. The fold and the reconciliation are
written as SQL and run in **duckdb** directly over the Parquet files — the analysis is the same
question the application asks of Postgres, so it reads better as SQL than as a chain of dataframe
operations, and it stays close to the read-model definition it is checking.

`psycopg` is deliberately **not** a default dependency. It is an optional extra so that installing
the analytics environment does not, by itself, make it possible to connect to the application
database.
