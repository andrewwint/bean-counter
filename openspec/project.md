# Project Context

## Purpose
bean-counter is inventory for a coffee shop, built on an **append-only event log**.

Nothing in this system stores "how much coffee we have." It stores **what happened** — beans
arrived, a bag went stale, someone counted the shelf on Monday morning — and derives the current
quantity by folding that history. The log is the source of truth; every number on screen is a
projection of it.

The reason the design matters: when the shelf count disagrees with the books, the log is the only
thing that can tell you *where* the coffee went. A system that stores a mutable `quantity` column
can tell you that you are short. It cannot tell you why.

## Tech Stack
- **Node v22** (pinned in `.nvmrc`; this machine's default `node` is v18 — run `nvm use` first)
- **TypeScript**, ESM (`"type": "module"`) throughout backend and frontend
- **npm** workspaces — the root package is the workspace root; `backend/` and `frontend/` are members
- **Postgres 16** via docker compose — the only datastore (no Redis, no secondary store)
- Backend: Express-style HTTP API, **zod** validation, `pg` driver. Port 3000.
- Frontend: **Vite + React + TypeScript**. Port 5173.
- Analytics: **Python + uv**, pandas / duckdb / matplotlib, Jupyter notebooks over Parquet exports
- Infra: **AWS CDK v2 (TypeScript)** — skeleton only, nothing deployed

## Project Conventions

### Code Style
- TypeScript strict mode. ESM imports with explicit extensions.
- Quantities are **integers in a base unit** — never a float, never a mixed unit. See Domain Context.
- Validation lives at the HTTP boundary (zod). Domain code may assume its inputs are already valid.
- Errors on the API surface: `400 { error: { code, message, details? } }`.
- Surgical diffs: change what the task needs, don't reformat or refactor adjacent code.

### Architecture Patterns
Postgres-only: an append-only `events` table plus an `item_stock` **materialized view** as the read
model. Deliberately **not** dual-store CQRS — one database, one transaction, no sync lag to reason
about at this size.

The three rules that are not negotiable:

1. **Base-unit integers.** Every quantity in the database, the API, and event payloads is an integer
   in a base unit (`g` / `ml` / `each`). Unit conversion happens in exactly one place: the UI
   formatting layer. A float in a quantity field is a bug, not a rounding preference.
2. **The event log is append-only.** `INSERT` is the only write permitted against `events`. No
   `UPDATE`, no `DELETE`, no "just fix that one row." A wrong recording is corrected by *appending*
   a correcting event (a `StockCounted` reset or a compensating `StockDepleted`). The mistake stays
   in the log — that is how a manager can later see that Tuesday's number was wrong and when it was
   caught. The derived read model is disposable and may be dropped and rebuilt at any time; only the
   log is sacred.
3. **Events are versioned from day one.** Every row carries `event_version` (default `1`). When a
   payload shape changes you bump the version on new writes and add an **upcaster** on the read path
   that maps old payloads forward in memory. History is never migrated in place.

The authoritative data contract — table DDL, event types and payloads, the read-model formula, HTTP
routes and error shape — is `docs/architecture/slice-1-contract.md`. Do not redefine those shapes
inside a change proposal; reference them.

### Testing Strategy
- Backend tests run against a real Postgres container (`make db-up && make migrate`), not a mock —
  the fold is a SQL question and mocking it would test the mock.
- `make test` runs backend + frontend. `make typecheck` and `make lint` are the narrower gates.
- A change to shared code (event schema, the fold, the contract) means running the full suite.

### Git Workflow
- Feature branches off `main`; one slice per branch.
- Nothing outward-facing — push, PR, tag, release — without the developer's explicit go-ahead.

## Domain Context

**Base units.** `g` (grams, beans), `ml` (milliliters, milk), `each` (count, cups and lids). Stored
as integers; displayed as kg / L / count by the UI only.

**Event types (v1).**
- `ItemDefined` `{ itemId, name, category, baseUnit }`
- `StockReceived` `{ itemId, quantity, supplier?, lotId? }` — quantity > 0
- `StockDepleted` `{ itemId, quantity, reason: "sale"|"waste"|"sample" }` — quantity > 0
- `StockCounted` `{ itemId, countedQuantity }` — an **absolute reset**, not a delta

**The read model.** Current quantity = the last physical count plus every delta recorded after it:

```
qty(item) = coalesce(last StockCounted.countedQuantity, 0)
          + sum(StockReceived.quantity  where sequence > that count's sequence)
          - sum(StockDepleted.quantity  where sequence > that count's sequence)
```

Items with no `StockCounted` fold from 0 over all events.

**Shrinkage** is the gap between what the log says you should have and what the shelf actually
holds — surfaced when a `StockCounted` lands below the folded expectation. It is the central
business question this system exists to answer, and the reason `StockCounted` is an absolute reset
rather than a correction delta: the count is evidence, and the gap it opens is the finding.

## Important Constraints
- **`psql` may or may not be on PATH.** If it is not, go through the container:
  `docker compose exec postgres psql -U beancounter -d bean_counter`
- **Node 22 only.** `make setup` fails loudly on anything else.
- **No secrets in the repo.** `.env` is gitignored; `.env.example` holds local-dev placeholders only.
- **Nothing in `infra/` is deployed.** No `cdk deploy` or `cdk bootstrap` without a security review
  and an owner's approval.
- Analytics reads an **exported snapshot**, never a live application-database connection by default.

## Folder Map
```
backend/      Node 22 + TypeScript HTTP API, zod validation, pg. Port 3000.
frontend/     Vite + React + TypeScript. The "stock board" UI. Port 5173.
analytics/    Python (uv) notebooks over Parquet exports of the read model.
infra/        AWS CDK v2 skeleton. Not deployed.
openspec/     Spec-driven change proposals (this folder).
docs/         Architecture docs — start with docs/architecture/slice-1-contract.md.
.claude/      Vendored Baton skill.
.agents/      Run trail from agent sessions. Committed on purpose.
```

## Make Targets
`make` is the single entry point; `make help` lists everything.

| Target | What it does |
| --- | --- |
| `make setup` | Verify Node 22, install backend + frontend deps |
| `make dev` | Start Postgres, then backend and frontend together |
| `make db-up` / `make db-down` | Start / stop the Postgres container |
| `make db-reset` | Destroy the volume and rebuild from migrations |
| `make migrate` | Apply database migrations (delegates to `backend/`) |
| `make seed` | Load the sample week of coffee-shop events |
| `make test` | Backend + frontend test suites |
| `make lint` / `make typecheck` | Narrower gates |
| `make analytics-export` | Dump the read model to `analytics/data/*.parquet` |
| `make notebook` | Launch the analytics notebook server |
| `make clean` | Remove build output and installed dependencies |

## External Dependencies
- **Postgres 16** (docker compose, local) — the only runtime dependency of the application.
- **AWS** (CDK skeleton only) — VPC / RDS / container hosting shapes are described in `infra/`
  but nothing is provisioned, and no account id or credential is committed.
