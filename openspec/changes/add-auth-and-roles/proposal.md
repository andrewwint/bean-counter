# Change: Authentication and roles — barista vs. manager

## Why
Every event in the log today is anonymous. The log records *what* happened but not *who* recorded it,
which means the one question a shrinkage investigation always ends on — "who counted the shelf that
morning?" — has no answer in the system that exists to answer it.

There is a sharper problem underneath. `StockCounted` is an **absolute reset**: it overwrites the
expected quantity with a claimed one and, in doing so, erases the shrinkage gap. Anyone who can
record a count can make a shortfall disappear without leaving a discrepancy behind. That is not a
theoretical exposure; it is the standard way inventory shrinkage gets covered up. Until the system
knows who is acting, it cannot enforce the boundary that matters.

## What Changes
- Add authenticated users with two roles: **barista** and **manager**.
- Stamp every appended event with the acting user (`actor_id`) and their role at the time of writing.
- **BREAKING:** `POST /api/events` requires authentication. Unauthenticated writes are rejected `401`.
- Authorize by event type. Baristas may record the flow of the shop day — `StockReceived`,
  `StockDepleted`, `ProductSold`. Only a **manager** may record `StockCounted`, because that event
  can close a shrinkage gap without evidence.
- Require a `note` on any `StockCounted` whose counted quantity differs from the folded expectation
  by more than a configured threshold — an unexplained adjustment must at least be an explained one.
- Surface actor and role on `GET /api/items/:itemId/history`, so a count is attributable on sight.
- Reads (`GET /api/stock`, history) require authentication but not a specific role.

## Impact
- Affected specs: `auth-and-roles` (new capability)
- Affected code: `backend/src/` (auth middleware, session handling, per-event-type authorization),
  `backend/migrations/` (users table; `actor_id` and `actor_role` columns on `events`),
  `frontend/` (login, and hiding the count control from baristas), `analytics/` (actor in the export)
- Interacts with `add-recipe-bom-depletion`: `RecipeRevised` must also be manager-only, because
  changing a recipe silently moves the expected stock line and therefore moves apparent shrinkage.
