## 1. Event schema
- [ ] 1.1 Add `ProductDefined`, `RecipeRevised`, and `ProductSold` zod schemas at the HTTP boundary
- [ ] 1.2 Reject a recipe line whose quantity is not a positive integer, or whose unit disagrees with the ingredient's `baseUnit`
- [ ] 1.3 Reject a `ProductSold` whose `productId` was never defined, and whose `recipeVersion` does not exist
- [ ] 1.4 Write the events at `event_version` 1 and document the upcast path in `src/events/schema.ts`

## 2. Recipe resolution
- [ ] 2.1 Fold `ProductDefined` + `RecipeRevised` into a per-product, per-version recipe table in memory
- [ ] 2.2 Pin `recipeVersion` onto every `ProductSold` at write time from the current recipe
- [ ] 2.3 Implement the exploder: `(ProductSold, recipe) -> [{ itemId, quantity }]`, integer-only

## 3. Read model
- [ ] 3.1 Extend the `item_stock` fold so recipe-exploded depletion is subtracted alongside `StockDepleted`
- [ ] 3.2 Confirm a `StockCounted` reset still truncates recipe-driven depletion the same way
- [ ] 3.3 Benchmark the fold over a year of simulated sales; record the number in the proposal

## 4. API and UI
- [ ] 4.1 `POST /api/events` accepts the three new types
- [ ] 4.2 `GET /api/products` returns products with their current recipe
- [ ] 4.3 `GET /api/items/:itemId/history` shows recipe-driven depletion as a derived line, clearly marked as derived rather than recorded
- [ ] 4.4 Frontend: a "sell a drink" control that posts one `ProductSold`

## 5. Analytics
- [ ] 5.1 Export recipe-explained depletion as its own column in the analytics snapshot
- [ ] 5.2 Split the notebook's variance chart into explained vs. unexplained

## 6. Tests
- [ ] 6.1 Selling 10 lattes depletes exactly 180 g beans, 2000 ml milk, 10 cups, 10 lids
- [ ] 6.2 A recipe revised mid-history does not change the ingredient totals of earlier sales
- [ ] 6.3 A sale of a product with a missing ingredient definition is rejected at the boundary
- [ ] 6.4 Full-suite run: `make test`
