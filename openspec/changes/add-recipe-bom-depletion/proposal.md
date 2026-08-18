# Change: Recipes / bill-of-materials so a sale depletes its ingredients

## Why
Today the only way to record a sale is to append one `StockDepleted` event per ingredient, by hand.
A barista selling a latte would have to record four events — 18 g beans, 200 ml milk, 1 cup, 1 lid —
and get every number right, mid-rush, at the register. That will not happen, so ingredient depletion
silently does not get recorded, and every shortfall lands in the shrinkage bucket where it teaches
the manager nothing.

A recipe (a bill of materials) turns "sold one latte" into the four depletions the shop actually
incurred, deterministically, from one recorded fact.

## What Changes
- Add a `ProductDefined` event: a sellable product (latte, flat white, drip) with a recipe — a list
  of `{ itemId, quantity }` lines in the item's own base unit.
- Add a `ProductSold` event: `{ productId, quantity, recipeVersion }`. This is the fact the register
  records. **It does not carry ingredient amounts.**
- Add a `RecipeRevised` event so a recipe can change (the shop re-dials the espresso to 19 g)
  without rewriting the products already sold under the old recipe.
- Explode `ProductSold` into ingredient depletions **on the read path**, using the recipe version
  pinned on the event — so a fold over history reproduces exactly what was true at the time.
- Extend the read model so `item_stock` accounts for recipe-driven depletion alongside direct
  `StockDepleted` events.
- Extend the analytics shrinkage notebook to split the variance into *recipe-explained* depletion
  and *unexplained* remainder — which is the number the manager actually wants.

## Impact
- Affected specs: `recipe-depletion` (new capability)
- Affected code: `backend/src/events/` (new event types, upcasters, zod schemas),
  the `item_stock` read model in `backend/migrations/`, `frontend/` (a sell-product control),
  `analytics/notebooks/01-shrinkage.ipynb` (explained vs. unexplained split)
- Depends on nothing; `add-projection-table` becomes more valuable after this lands because the
  fold gets meaningfully more expensive.
