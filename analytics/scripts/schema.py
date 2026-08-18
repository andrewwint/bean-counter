"""The snapshot schema and item vocabulary shared by the fixture generator, the real
export, and the notebook.

Both `make fixtures` and `make export` must write the same columns -- and the same
category values -- or the notebook works against one and breaks against the other.
That is the only reason this module exists: it is the single definition of the two
files under `analytics/data/`, and of the vocabulary that describes their rows.

Quantities are integers in a base unit (g / ml / each), exactly as they are stored in
the event log. Nothing in the analytics layer converts units; the notebook formats for
display at the very end and nowhere else.
"""

# events.parquet -- a flattened view of the append-only `events` table.
# The jsonb payload is split into typed columns; a column is null where the event
# type does not carry that field. The log itself is never reshaped, only read.
EVENT_COLUMNS = {
    "sequence": "int64",  # global order -- the fold reads this
    "event_id": "string",
    "item_id": "string",  # `stream_id` in the log
    "event_type": "string",  # ItemDefined | StockReceived | StockDepleted | StockCounted
    "event_version": "int32",  # readers switch on this; v1 is all that exists today
    "quantity": "Int64",  # StockReceived / StockDepleted    (nullable int, never float)
    "counted_quantity": "Int64",  # StockCounted -- an absolute reset, not a delta
    "reason": "string",  # StockDepleted: sale | waste | sample
    "supplier": "string",  # StockReceived, optional
    "lot_id": "string",  # StockReceived, optional
    "name": "string",  # ItemDefined only
    "category": "string",  # ItemDefined only
    "base_unit": "string",  # ItemDefined only: g | ml | each
    "occurred_at": "datetime64[us, UTC]",  # when it happened in the shop
    "recorded_at": "datetime64[us, UTC]",  # when the system heard about it
}

# stock.parquet -- the read model (`item_stock`) as of the export.
# Derived data: it holds nothing that could not be recomputed from events.parquet.
# The notebook recomputes it anyway, and the agreement is the first check it runs.
STOCK_COLUMNS = {
    "item_id": "string",
    "name": "string",
    "category": "string",
    "base_unit": "string",
    "quantity": "int64",
    "last_event_at": "datetime64[us, UTC]",
}


def coerce(frame, columns):
    """Return `frame` with exactly `columns`, in order, at the declared dtypes."""
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        raise ValueError(f"snapshot is missing columns: {missing}")
    return frame[list(columns)].astype(columns)


# The item vocabulary the application actually speaks.
#
# `category` is a free-text jsonb field in the log, so nothing in Postgres stops the two
# sides of this layer from disagreeing about what a milk is called -- and they did: the
# fixtures wrote "dairy" while the backend seeds "milk", which silently emptied the
# notebook's milk section against real data while the fixtures looked fine. Defining the
# vocabulary once, here, is what stops that: the fixture generator writes these values and
# the notebook selects by them, so there is no second literal left to drift.
#
# Source of truth is the `ItemDefined` payloads in backend/src/seed.ts. If the backend adds
# a category, add it here -- `check_vocabulary` below fails loudly until someone does.
BEANS = "beans"
MILK = "milk"
PACKAGING = "packaging"
CATEGORIES = (BEANS, MILK, PACKAGING)


def check_vocabulary(stock):
    """Fail if the snapshot holds a category this layer does not know about.

    Loud beats silent. An unknown category means an item is invisible to every
    per-category section of the notebook, which is exactly the failure that hid before.
    """
    unknown = sorted(set(stock.category.dropna()) - set(CATEGORIES))
    if unknown:
        raise ValueError(
            f"snapshot holds categories this layer does not know: {unknown}.\n"
            f"  known: {list(CATEGORIES)} (scripts/schema.py, mirroring backend/src/seed.ts)"
        )


def select_category(frame, category):
    """Rows of `frame` in `category` -- raising rather than returning an empty frame.

    The notebook's per-category sections are written about a category it expects to be
    there. Silently rendering nothing is how the "dairy"/"milk" divergence survived: the
    section still printed its heading, just with no rows under it.
    """
    if category not in CATEGORIES:
        raise ValueError(f"{category!r} is not in the vocabulary: {list(CATEGORIES)}")
    rows = frame[frame.category == category]
    if rows.empty:
        raise ValueError(
            f"no rows in category {category!r}; the data holds "
            f"{sorted(set(frame.category.dropna()))}"
        )
    return rows
