"""Export the event log and the read model from Postgres to analytics/data/*.parquet.

This script is the *only* place in the analytics layer that talks to the application
database, and it runs as a batch step -- never from inside a notebook. See
analytics/README.md, "The read path", for why that boundary exists.

Usage:
    make export                    # from analytics/, or `make analytics-export` from the repo root

Requires:
    - the `db` extra:  uv sync --extra db
    - DATABASE_URL in the environment or in a .env file

If you have no database running, use `make fixtures` instead -- the notebook is designed
to run against the sample snapshot without one.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

from schema import EVENT_COLUMNS, STOCK_COLUMNS, coerce

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# The log, with the jsonb payload flattened into the typed columns the notebook expects.
# Read-only by construction: analytics never writes to the event log, and the log is
# append-only anyway -- there is no UPDATE this script could legitimately issue.
EVENTS_SQL = """
SELECT
    sequence,
    event_id::text                              AS event_id,
    stream_id                                   AS item_id,
    event_type,
    event_version,
    (payload ->> 'quantity')::bigint            AS quantity,
    (payload ->> 'countedQuantity')::bigint     AS counted_quantity,
    payload ->> 'reason'                        AS reason,
    payload ->> 'supplier'                      AS supplier,
    payload ->> 'lotId'                         AS lot_id,
    payload ->> 'name'                          AS name,
    payload ->> 'category'                      AS category,
    payload ->> 'baseUnit'                      AS base_unit,
    occurred_at,
    recorded_at
FROM events
ORDER BY sequence
"""

STOCK_SQL = """
SELECT item_id, name, category, base_unit, quantity, last_event_at
FROM item_stock
ORDER BY item_id
"""


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    load_dotenv()
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")  # the repo root .env, if there is one

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        fail(
            "DATABASE_URL is not set.\n"
            "  For a live export:  export DATABASE_URL=postgres://... && make export\n"
            "  With no database:   make fixtures   (sample snapshot, runs the notebook standalone)"
        )

    try:
        import psycopg  # imported here so `make fixtures` works without the `db` extra
    except ModuleNotFoundError:
        fail("psycopg is not installed. It is an optional extra: run `uv sync --extra db`.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(database_url) as conn:
        events = coerce(pd.read_sql(EVENTS_SQL, conn), EVENT_COLUMNS)
        stock = coerce(pd.read_sql(STOCK_SQL, conn), STOCK_COLUMNS)

    events.to_parquet(DATA_DIR / "events.parquet", index=False)
    stock.to_parquet(DATA_DIR / "stock.parquet", index=False)
    print(f"wrote {len(events)} events and {len(stock)} stock rows to {DATA_DIR}")
    print("source: LIVE DATABASE")


if __name__ == "__main__":
    main()
