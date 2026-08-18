"""Generate the sample snapshot under analytics/data/ so the notebook runs standalone.

These are fixtures, not real data. They exist so `analytics/notebooks/01-shrinkage.ipynb`
executes top to bottom on a clean checkout, before anyone has a database running -- and so
the notebook can be reviewed and tested without one.

They describe the same shop as `make seed`, in the same vocabulary -- the item ids, names and
categories below are exactly the ones backend/src/seed.ts writes, because a notebook that only
works against fixtures is a notebook nobody has tested. The *numbers* are not the seed's: this
is a fuller week (sales closed out daily rather than batched by rush, plus a tasting), and it
carries one deliberately never-counted item so the notebook's fold-from-zero check has something
to cover. Do not read a quantity here as a claim about what is in Postgres.

The shortfall is deliberate and is the whole point. It is not noise -- it is sized like
over-dosed espresso (a little on every shot) and unrecorded milk waste (steam-pitcher
leftovers down the drain), which is what shrinkage in a coffee shop actually looks like.
Run `make fixtures` to regenerate. Output is deterministic: no randomness, same bytes every time.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from schema import BEANS, EVENT_COLUMNS, MILK, PACKAGING, STOCK_COLUMNS, coerce

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# A fixed namespace so event ids are stable across regenerations -- a fixture that
# churns its ids on every run produces a noisy diff and teaches nobody anything.
NAMESPACE = uuid.UUID("6ba7b812-9dad-11d1-80b4-00c04fd430c8")

MONDAY = datetime(2026, 8, 3, tzinfo=timezone.utc)  # the week opens
COUNT_DAY = datetime(2026, 8, 10, tzinfo=timezone.utc)  # the Monday count that finds the gap

# Sales weighting across Mon..Sun. Saturday is the busy one; Sunday is short hours.
DAY_WEIGHTS = [10, 9, 10, 11, 14, 21, 8]

# Ids, names and categories match backend/src/seed.ts exactly; categories come from the
# shared vocabulary in schema.py so the notebook cannot be selecting on a different word.
ITEMS = [
    # item_id, name, category, base_unit, opening count, recorded sales over the week, counted on Monday
    ("bean-yirgacheffe", "Yirgacheffe", BEANS, "g", 8000, 14040, 4980),
    ("bean-huila", "Huila", BEANS, "g", 6000, 9200, 2610),
    ("bean-sumatra", "Sumatra Mandheling", BEANS, "g", 5000, 3500, 1400),
    ("milk-whole", "Whole Milk", MILK, "ml", 24000, 88000, 14200),
    ("milk-oat", "Oat Milk", MILK, "ml", 8000, 15600, 4250),
    ("cup-12oz", "12oz Cup", PACKAGING, "each", 450, 1180, 262),
    ("lid-12oz", "12oz Lid", PACKAGING, "each", 500, 1180, 320),
]

# A new line that arrived mid-week and has never been counted. The contract says such an
# item folds from 0 over its whole history, and the notebook's cross-check against the read
# model has to cover it -- when the check only looked at counted items, this was the case it
# silently skipped. Sales are recorded, so it is a real row, just one with no count window.
#   item_id, name, category, base_unit, delivered on day, quantity, sold over the rest of the week
NEVER_COUNTED = ("cup-16oz", "16oz Cup", PACKAGING, "each", 2, 600, 214)

# Deliveries: item_id, day offset from Monday, quantity, supplier, lot id
DELIVERIES = [
    ("bean-yirgacheffe", 2, 12000, "Bridge Road Roasters", "LOT-2026-W31-A"),
    ("bean-huila", 3, 6000, "Bridge Road Roasters", "LOT-2026-W31-B"),
    ("milk-whole", 1, 40000, "Valley Dairy", None),
    ("milk-whole", 4, 40000, "Valley Dairy", None),
    ("milk-oat", 1, 12000, "Valley Dairy", None),
    ("cup-12oz", 2, 1000, "Restaurant Depot", None),
    ("lid-12oz", 2, 1000, "Restaurant Depot", None),
]

# The things that are not sales: a stale batch binned, and a tasting.
NON_SALE_DEPLETIONS = [
    ("bean-yirgacheffe", 6, 400, "waste"),  # Sunday: a batch went stale over the weekend
    ("bean-sumatra", 3, 100, "sample"),  # Thursday: cupping for a customer
]


def split_across_week(total: int, weights: list[int]) -> list[int]:
    """Split an integer total across days by weight, staying integral.

    Base units are integers everywhere in this system, so the fixture generator does not
    get to produce 2005.7 g of beans on a Tuesday either. The remainder lands on the
    busiest day, which is where a rounding error would hide in real life anyway.
    """
    weight_sum = sum(weights)
    parts = [total * w // weight_sum for w in weights]
    parts[weights.index(max(weights))] += total - sum(parts)
    return parts


def build_events() -> pd.DataFrame:
    rows: list[dict] = []

    def add(item_id: str, event_type: str, occurred_at: datetime, **payload) -> None:
        row = {col: None for col in EVENT_COLUMNS}
        row.update(
            sequence=len(rows) + 1,
            # uuid5 over the natural key: same fixture in, same ids out.
            event_id=str(uuid.uuid5(NAMESPACE, f"{item_id}|{event_type}|{occurred_at.isoformat()}")),
            item_id=item_id,
            event_type=event_type,
            event_version=1,
            occurred_at=occurred_at,
            # The shop records as it goes, so `recorded_at` trails `occurred_at` slightly.
            recorded_at=occurred_at + timedelta(minutes=2),
            **payload,
        )
        rows.append(row)

    # Monday 07:00 -- the items exist.
    for item_id, name, category, base_unit, *_ in ITEMS:
        add(item_id, "ItemDefined", MONDAY + timedelta(hours=7), name=name, category=category, base_unit=base_unit)

    # Monday 07:15 -- last week's closing count becomes this week's baseline.
    for item_id, _, _, _, opening, _, _ in ITEMS:
        add(item_id, "StockCounted", MONDAY + timedelta(hours=7, minutes=15), counted_quantity=opening)

    # Deliveries land in the morning, before service.
    for item_id, day, quantity, supplier, lot_id in DELIVERIES:
        add(
            item_id,
            "StockReceived",
            MONDAY + timedelta(days=day, hours=8),
            quantity=quantity,
            supplier=supplier,
            lot_id=lot_id,
        )

    # Sales, closed out once at the end of each trading day.
    for item_id, _, _, _, _, weekly_sales, _ in ITEMS:
        for day, quantity in enumerate(split_across_week(weekly_sales, DAY_WEIGHTS)):
            add(
                item_id,
                "StockDepleted",
                MONDAY + timedelta(days=day, hours=18),
                quantity=quantity,
                reason="sale",
            )

    for item_id, day, quantity, reason in NON_SALE_DEPLETIONS:
        add(item_id, "StockDepleted", MONDAY + timedelta(days=day, hours=19), quantity=quantity, reason=reason)

    # The never-counted line: defined and delivered mid-week, sold from the day it lands,
    # and never counted -- so it has no count window and folds from 0 over all its events.
    nc_id, nc_name, nc_category, nc_unit, nc_day, nc_received, nc_sold = NEVER_COUNTED
    add(
        nc_id,
        "ItemDefined",
        MONDAY + timedelta(days=nc_day, hours=7),
        name=nc_name,
        category=nc_category,
        base_unit=nc_unit,
    )
    add(
        nc_id,
        "StockReceived",
        MONDAY + timedelta(days=nc_day, hours=8),
        quantity=nc_received,
        supplier="Restaurant Depot",
    )
    for offset, quantity in enumerate(split_across_week(nc_sold, DAY_WEIGHTS[nc_day:])):
        add(
            nc_id,
            "StockDepleted",
            MONDAY + timedelta(days=nc_day + offset, hours=18),
            quantity=quantity,
            reason="sale",
        )

    # The following Monday, 07:00: someone counts the shelves. This is the event that
    # turns a hunch into a number.
    for item_id, _, _, _, _, _, counted in ITEMS:
        add(item_id, "StockCounted", COUNT_DAY + timedelta(hours=7), counted_quantity=counted)

    frame = pd.DataFrame(rows).sort_values("occurred_at", kind="stable").reset_index(drop=True)
    frame["sequence"] = range(1, len(frame) + 1)  # sequence follows commit order
    return coerce(frame, EVENT_COLUMNS)


def build_stock(events: pd.DataFrame) -> pd.DataFrame:
    """Fold the events into the read model, using the contract's formula.

    qty = coalesce(last StockCounted.countedQuantity, 0)
        + receipts after that count
        - depletions after that count

    For every counted item the last count *is* Monday's, and nothing was recorded after
    it, so every quantity equals its counted quantity. That is the honest answer and it is
    also the uncomfortable one: the count silently absorbed the shortfall. Finding out how
    much it absorbed is what the notebook is for. The never-counted line is the exception
    -- it folds from 0 over its whole stream, which is what `coalesce(counted_at_sequence,
    0)` does in backend/migrations/002_item_stock.sql.
    """
    defined = events[events.event_type == "ItemDefined"].set_index("item_id")
    rows = []
    for item_id, group in events.groupby("item_id", sort=False):
        counts = group[group.event_type == "StockCounted"]
        if counts.empty:
            last_count_seq, quantity = 0, 0
        else:
            last_count_seq = int(counts.sequence.max())
            quantity = int(counts.loc[counts.sequence.idxmax(), "counted_quantity"])
        after = group[group.sequence > last_count_seq]
        quantity += int(after.loc[after.event_type == "StockReceived", "quantity"].fillna(0).sum())
        quantity -= int(after.loc[after.event_type == "StockDepleted", "quantity"].fillna(0).sum())
        rows.append(
            {
                "item_id": item_id,
                "name": defined.loc[item_id, "name"],
                "category": defined.loc[item_id, "category"],
                "base_unit": defined.loc[item_id, "base_unit"],
                "quantity": quantity,
                "last_event_at": group.occurred_at.max(),
            }
        )
    return coerce(pd.DataFrame(rows), STOCK_COLUMNS)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    events = build_events()
    stock = build_stock(events)
    events.to_parquet(DATA_DIR / "events.parquet", index=False)
    stock.to_parquet(DATA_DIR / "stock.parquet", index=False)
    print(f"wrote {len(events)} events and {len(stock)} stock rows to {DATA_DIR}")
    print("source: FIXTURES (sample data, not a real shop)")


if __name__ == "__main__":
    main()
