"""The snapshot schema shared by the fixture generator and the real export.

Both `make fixtures` and `make export` must write the same columns, or the notebook
works against one and breaks against the other. That is the only reason this module
exists -- it is the single definition of the two files under `analytics/data/`.

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
