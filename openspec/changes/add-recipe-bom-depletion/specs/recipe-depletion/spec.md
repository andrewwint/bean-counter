## ADDED Requirements

### Requirement: Product Recipe Definition
The system SHALL allow a sellable product to be defined with a recipe — an ordered list of ingredient lines, each naming an existing item and a positive integer quantity in that item's base unit.

#### Scenario: A latte is defined with four ingredient lines
- **WHEN** a `ProductDefined` event is recorded with `productId: "latte"` and lines `[{ beans, 18 }, { whole-milk, 200 }, { cup-12oz, 1 }, { lid-12oz, 1 }]`
- **THEN** the product is available to sell
- **AND** its recipe is recorded at version 1

#### Scenario: A recipe line with a fractional quantity is rejected
- **WHEN** a `ProductDefined` event is recorded with a line quantity of `18.5`
- **THEN** the request is rejected with `400` and the event is not appended to the log

#### Scenario: A recipe line naming an unknown item is rejected
- **WHEN** a `ProductDefined` event names an `itemId` that has no `ItemDefined` event in the log
- **THEN** the request is rejected with `400` and the event is not appended to the log

### Requirement: Sale Records The Product, Not The Ingredients
The system MUST record a sale as a single `ProductSold` event naming the product, the number sold, and the recipe version in force at that moment; the event SHALL NOT carry ingredient quantities.

#### Scenario: Selling three lattes appends exactly one event
- **WHEN** the register records a sale of 3 lattes
- **THEN** exactly one `ProductSold` event is appended with `{ productId: "latte", quantity: 3, recipeVersion: 1 }`
- **AND** no `StockDepleted` event is appended for any ingredient

#### Scenario: The recipe version is pinned at write time
- **WHEN** a `ProductSold` event is accepted
- **THEN** the `recipeVersion` stored on the event is the version current when the sale was recorded, not the version current when the event is later read

### Requirement: Ingredient Depletion Is Derived On The Read Path
The system SHALL derive ingredient depletion by exploding each `ProductSold` against the recipe version pinned on that event, so that replaying the log reproduces the depletion that was true when the sale happened.

#### Scenario: Ten lattes deplete their exact bill of materials
- **GIVEN** the latte recipe at version 1 is 18 g beans, 200 ml milk, 1 cup, 1 lid
- **WHEN** a `ProductSold` of 10 lattes at `recipeVersion: 1` is folded
- **THEN** the fold subtracts 180 g of beans, 2000 ml of milk, 10 cups, and 10 lids

#### Scenario: A revised recipe does not rewrite earlier sales
- **GIVEN** 10 lattes were sold at `recipeVersion: 1` (18 g beans)
- **WHEN** a `RecipeRevised` event raises the dose to 19 g, creating version 2
- **AND** 10 more lattes are sold at `recipeVersion: 2`
- **THEN** the total beans depleted is 370 g, not 380 g

#### Scenario: A physical count still truncates derived depletion
- **GIVEN** recipe-driven depletion exists before and after a `StockCounted` event for beans
- **WHEN** the read model folds the beans stream
- **THEN** only depletion derived from sales after the count's `sequence` is subtracted from the counted quantity

### Requirement: Derived Depletion Is Labelled As Derived
The system MUST distinguish derived ingredient depletion from directly recorded `StockDepleted` events wherever item history is presented, so a reader can tell a recorded fact from a computed consequence.

#### Scenario: Item history marks a recipe-driven line
- **WHEN** `GET /api/items/beans/history` is requested for an item depleted by sales
- **THEN** each recipe-driven line is marked as derived and names the `ProductSold` event it came from
- **AND** directly recorded `StockDepleted` events are not marked as derived
