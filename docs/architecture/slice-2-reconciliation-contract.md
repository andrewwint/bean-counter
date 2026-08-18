# Slice 2 — reconciliation API contract

Authoritative for the reconciliation lanes. Base units and error shape inherit from
`slice-1-contract.md` (integers only; `400 { error: { code, message, details? } }`).

## The question this answers
"We bought 12 kg and counted 11.2 — where did it go?" The seed deliberately creates this gap and
slice 1 gave no way to see it. **Variance is the product.**

## Definition
A `StockCounted` event is an absolute reset. At the moment of each count, the log *predicted* a
quantity. The difference is the variance:

```
expectedAtCount(c) = fold over all events with sequence < c.sequence
                     (previous count as baseline, plus later receipts minus later depletions)
variance(c)        = c.countedQuantity - expectedAtCount(c)
```

- `variance < 0` — **shrinkage**: less on the shelf than the log predicted (over-dosing, unrecorded
  waste, spoilage, theft). This is the number a shop owner cares about.
- `variance > 0` — **overage**: more than predicted, which usually means a delivery was never recorded.
- `variance = 0` — reconciles.

Report variance in the item's **base unit** as an integer. Never round in the API; the UI formats.
`variancePct` is relative to `expectedAtCount` and is `null` when `expectedAtCount = 0` (no
denominator — do NOT emit `Infinity` or `0`).

## Endpoints

### `GET /api/items/:itemId/reconciliation`
```jsonc
{
  "itemId": "bean-yirgacheffe",
  "name": "Yirgacheffe",
  "baseUnit": "g",
  "counts": [                          // chronological by sequence
    {
      "sequence": 31,
      "occurredAt": "2026-08-10T14:05:00.000Z",
      "countedQuantity": 15850,
      "expectedQuantity": 16100,
      "variance": -250,                // negative = shrinkage
      "variancePct": -1.55             // or null when expectedQuantity is 0
    }
  ],
  "totalVariance": -250,               // sum over counts, base units
  "sinceLastCount": {                  // movement after the most recent count
    "received": 0,
    "depleted": { "sale": 0, "waste": 0, "sample": 0 },
    "expectedQuantity": 15850          // must equal item_stock.quantity — an internal consistency check
  }
}
```
`404 { error: { code: "NOT_FOUND", ... } }` when the item has no `ItemDefined`.
An item with **no** `StockCounted` returns `counts: []`, `totalVariance: 0`, and a populated
`sinceLastCount` folding from 0 — NOT a 404, and not an error.

### `GET /api/reconciliation`
The shop-wide shrinkage report, one row per defined item, ordered by **most negative variance first**
(worst shrinkage at the top — that is the point of the screen):
```jsonc
[ { "itemId": "...", "name": "...", "category": "...", "baseUnit": "g",
    "totalVariance": -250, "lastCountAt": "...", "countsRecorded": 2 } ]
```

## Invariant worth testing
`sinceLastCount.expectedQuantity` MUST equal the item's `item_stock.quantity`. They are computed by
different paths over the same log; if they ever disagree, one of them is wrong. Assert it.

---

## Resolved ambiguities (raised while implementing the reconciliation API)

Real holes in this contract's first draft, settled during slice 2. Recorded so nobody relitigates them.

1. **An item's first count is an OPENING BALANCE, not a variance — and is never scored.**
   The definition above (`variance = counted - expectedAtCount`) applied literally to a first count
   books the shop's entire opening stock as overage: the seeded week reported `bean-yirgacheffe`
   `totalVariance: +11650` when the real shrinkage is `-350`, and every item had the same shape, so
   the whole report read "you have far more stock than expected" while the truth was a consistent
   small shortfall.

   A count is an opening balance when **no event that predicts a quantity precedes it** —
   no `StockReceived`, no `StockDepleted`, no earlier `StockCounted`. `ItemDefined` does not count:
   naming an item forecasts nothing.

   - The count stays in `counts[]` — it is real history — carrying `"isOpeningBalance": true`,
     `"variance": null` and `"variancePct": null`.
   - It contributes **nothing** to `totalVariance`.
   - The discriminator is "was anything known before this count?", **never** "did `expectedQuantity`
     work out to 0?". An item that was received and then counted at `0` has a real, and very bad,
     variance — see ambiguity 3.

   Every count field is present on every row: `isOpeningBalance` is `false`, not absent, on a scored count.

2. **`variancePct` is rounded to two decimals** — matching the example above (`-1.55`), not the raw
   `-1.5527950310559007`. "Never round in the API" governs quantities in base units; the percentage
   is derived and both exact integers (`variance`, `expectedQuantity`) ship alongside it, so nothing
   is lost. A value that rounds to `-0` is normalised to `0`. `variancePct` is `null` whenever
   `expectedQuantity` is 0 — including for a scored count that legitimately expected nothing.

3. **`countedQuantity: 0` after real movement is a genuine variance**, not an opening balance
   (slice-1 resolved ambiguity 2 makes the event legal). "We received 5 kg and the shelf is bare" is
   `variance: -5000`, `variancePct: -100`.

4. **`GET /api/reconciliation` ranks by PERCENTAGE, not by raw variance.** `totalVariance` is in the
   item's own base unit, so ranking `-900 ml` against `-350 g` against `-47 each` compares
   incommensurable quantities — numerically correct and semantically meaningless. The ranking key is
   returned so the UI can show why a row sits where it does:

   ```jsonc
   [ { "itemId": "milk-whole", "name": "Whole Milk", "category": "milk", "baseUnit": "ml",
       "totalVariance": -900,        // display, in base units
       "totalVariancePct": -6,       // ranking key: unit-free, null when nothing is scorable
       "lastCountAt": "2026-08-10T14:05:00.000Z", "countsRecorded": 2 } ]
   ```

   `totalVariancePct` = total variance over total expected across that item's **scored** counts.
   Order: most negative percentage first; ties by `name`. Ranking uses the exact ratio, not the
   rounded percentage, so rows that display the same figure still order deterministically.

5. **Items with nothing scorable sort LAST**, with `totalVariancePct: null` — never counted, or
   counted only as an opening balance. They are **reported, never filtered out**: an item the shop
   has never counted is exactly the item a manager needs to see. But "reconciles exactly" and "we
   have no idea" are different states and must not sit adjacent in the ranking.

6. **`lastCountAt` is `null` for a never-counted item**, key always present. Never an epoch, never
   the item's definition time: a non-null-but-meaningless timestamp cannot be told apart from a real
   count.

7. **`totalVariance` is `0` for a never-counted item**, matching the detail endpoint. Because that
   `0` is indistinguishable from "counted and reconciled exactly", **`countsRecorded` is the field
   that disambiguates** and is always an accurate count of `StockCounted` events — including `0`,
   and including counts that were opening balances. The UI keys its "never counted" rendering off
   `countsRecorded === 0`.

8. **The detail response is read in one snapshot.** Its three reads run inside a single
   `REPEATABLE READ READ ONLY` transaction, so an append landing mid-request cannot produce a body
   whose `counts` and `sinceLastCount` disagree — which is precisely the invariant above.

## The seeded week (ground truth)

Regression-tested in `backend/test/reconciliation-seed.test.ts`, and independently corroborated by
hand-written SQL over `events` and by the analytics lane's Parquet fold in Python. Every real
variance in the seed is negative or zero; **a positive total here is a bug, not a finding.**

| item | opening balance (unscored) | expected Monday | counted | totalVariance | totalVariancePct |
| --- | --- | --- | --- | --- | --- |
| `milk-whole` | 24000 | 15000 | 14100 | **-900** | -6 |
| `cup-12oz` | 800 | 1657 | 1610 | **-47** | -2.84 |
| `bean-huila` | 8000 | 6400 | 6250 | **-150** | -2.34 |
| `bean-yirgacheffe` | 12000 | 16200 | 15850 | **-350** | -2.16 |
| `lid-12oz` | 800 | 657 | 657 | 0 | 0 |
| `milk-oat` | 12000 | 20500 | 20500 | 0 | 0 |
| `bean-sumatra` | 5000 | 4100 | 4100 | 0 | 0 |

Rows are listed in the order `GET /api/reconciliation` returns them.
