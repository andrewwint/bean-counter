## Context

This is the hardest remaining domain problem in bean-counter, and the difficulty is not the data
model — a recipe is a list of `{ itemId, quantity }` lines. The difficulty is **where the explosion
happens and what gets written to the log**, because that choice is permanent. The event log is
append-only; a decision to store ingredient quantities on a sale event cannot be walked back
without rewriting history, which rule 2 forbids.

Constraints inherited from `docs/architecture/slice-1-contract.md`:
- quantities are integers in a base unit,
- `events` is append-only and never migrated in place,
- `event_version` carries schema evolution forward via read-path upcasters,
- there is one datastore and one transaction.

## Goals / Non-Goals

**Goals**
- A barista records one fact — "sold three lattes" — and the shop's ingredient stock moves correctly.
- Replaying the log a year from now reproduces exactly the depletion that was true at the time.
- The shrinkage number splits into *explained by recipe* and *unexplained remainder*.

**Non-Goals**
- Yield / brew-ratio modelling (grams of beans to milliliters of liquid espresso). Out of scope.
- Costing, margin, or supplier pricing. This slice tracks quantity, not money.
- Partial or modified drinks ("extra shot", "half-caff"). See Open Questions.
- Sub-recipes (a syrup made in-house from sugar and water). Recipes are one level deep for now.

## Decisions

### Decision 1: `ProductSold` stores the product and a recipe version, not the ingredients

The event carries `{ productId, quantity, recipeVersion }`. Ingredient amounts are derived on read.

**Alternatives considered:**

- *Explode at write time into N `StockDepleted` events.* Tempting, because the read model then needs
  no change at all and the fold stays trivial. Rejected: it destroys the fact that a sale happened.
  Once written, the log holds "18 g of beans left" four times over with no record that those four
  lines were one latte. You cannot later ask "how many lattes did we sell", you cannot correct a
  mis-specified recipe without a mess of compensating events, and you cannot tell a recipe-driven
  depletion from a barista's hand-recorded waste. The log's job is to hold *what happened*; what
  happened was a sale.
- *Store the full exploded bill of materials inline on the `ProductSold` payload.* Self-contained and
  replay-proof without a recipe lookup. Rejected as the primary design because it makes every sale
  event carry duplicated recipe data — and if the recipe was wrong, the error is now copied across
  thousands of rows. The version pointer keeps the correction in one place.
- **Chosen:** version pointer. One place to fix a recipe, and history stays honest.

### Decision 2: recipes are themselves event-sourced, and versions are immutable

`ProductDefined` creates version 1. Each `RecipeRevised` creates version N+1 and never alters an
existing version. `ProductSold` pins the version **at write time**, read from the current recipe.

This is the load-bearing decision for replay determinism. If the sale pointed at "the product" and
the reader resolved "the current recipe", then re-dialling the espresso from 18 g to 19 g would
retroactively change how much coffee last month's sales consumed — and last month's shrinkage number
would move. A shrinkage number that changes when you change a recipe is not evidence of anything.

### Decision 3: the exploder is a pure function, and it is integer-only

`explode(sale, recipe) -> [{ itemId, quantity }]` where `quantity = line.quantity * sale.quantity`.
Integer multiplication only. There is deliberately no place in this design where a ratio, a yield
factor, or a unit conversion could introduce a float — consistent with rule 1. If a future
requirement needs 1.5 pumps of syrup, the answer is to change the base unit (pumps to milliliters),
not to allow a fraction.

### Decision 4: keep the materialized view in slice 1 terms; do not couple to `add-projection-table`

The fold gains a join against resolved recipes. That is a real cost increase and it strengthens the
case for `add-projection-table`, but the two changes stay independent — the read model was never the
source of truth, so it can be swapped underneath this feature at any time.

## Risks / Trade-offs

- **The fold gets more expensive.** Every read now resolves recipe versions and multiplies out sales.
  → Mitigation: benchmark against a year of simulated sales (task 3.3) before choosing whether to
  land `add-projection-table` first.
- **A wrong recipe silently corrupts the stock picture** — every sale under it is wrong, and unlike a
  mistyped `StockDepleted` it is invisible at the register. → Mitigation: the shrinkage notebook's
  explained/unexplained split is the detector. A recipe error shows up as a *persistent, one-item*
  drift rather than the noisy scatter that real shrinkage produces. Say so in the notebook.
- **Derived lines can be mistaken for recorded facts.** A manager reading item history could believe
  a computed depletion was something a human observed. → Mitigation: the spec requires derived lines
  to be labelled as derived (this is a correctness-of-evidence requirement, not decoration).
- **Recipe changes are a quiet financial lever.** Whoever may revise a recipe can move the expected
  stock line and therefore move the apparent shrinkage. → This belongs to `add-auth-and-roles`;
  flagged here so the two proposals are read together. `RecipeRevised` must be manager-only.

## Migration Plan

Additive and backward compatible. All existing `StockDepleted` events remain valid and keep meaning
exactly what they meant — direct, recorded depletion.

1. Ship the event schemas and the pure exploder with tests. Nothing changes in production behavior.
2. Ship `POST /api/events` acceptance for the new types. Recipes can be defined; nothing sells yet.
3. Switch the read model to include exploded depletion, behind a rebuild of `item_stock`
   (the view is disposable — drop and recreate from the log).
4. Ship the register control.

**Rollback:** revert the read model to the slice-1 fold and stop writing `ProductSold`. The events
already written stay in the log and simply go un-exploded until the reader is restored. No data loss,
because nothing was ever deleted — which is the point of the whole design.

## Open Questions

- **Modifiers.** An extra shot is `+18 g` beans on one sale. Is that a recipe variant (`latte-double`,
  a separate product) or a per-sale modifier list on `ProductSold`? Variants are simpler and keep the
  event dumb; modifiers scale better past a handful of options. Leaning variants until the shop has
  more than ~10.
- **Waste of a made drink.** A barista pours a latte and drops it. Is that a `ProductSold` with
  `reason: "waste"`, or a sale plus nothing (the ingredients are gone either way)? The ingredients
  are equally consumed, but the revenue is not — and this system does not track revenue yet.
- **Should the recipe live in the log at all**, or in an ordinary mutable table? It is reference data,
  not history. It is in the log here because *when a recipe changed* is exactly the kind of question
  a shrinkage investigation asks, and a mutable table cannot answer it.
