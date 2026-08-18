# AGENTS.md — bean-counter

**This file is the single source of truth for how humans and AI agents work in this repo.**
`CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers to this file. If a rule
matters, it is written here once and nowhere else — do not copy rules into the pointer files.

## What this project is

bean-counter is inventory for a coffee shop, built on an **append-only event log**.

Nothing in this system stores "how much coffee we have." It stores **what happened** — beans
arrived, a bag went stale, someone counted the shelf on Monday morning — and derives the current
quantity from that history. The event log is the source of truth; every number you see on screen
is a fold over it.

## The rules that are not negotiable

### 1. Quantities are integers in a base unit

Every quantity — in the database, in the API, in event payloads — is an **integer in a base unit**.
Never a float. Never a mixed unit.

| Base unit | Stored as         | Shown to a human as               |
| --------- | ----------------- | --------------------------------- |
| `g`       | grams (int)       | kg for beans (`12000` -> "12 kg") |
| `ml`      | milliliters (int) | L for milk (`4000` -> "4 L")      |
| `each`    | count (int)       | as-is (cups, lids)                |

Unit conversion happens in **exactly one place**: the UI formatting layer. The API speaks base
units and only base units. A float in a quantity field is a bug, not a rounding preference —
`0.1 + 0.2` drift in an inventory system shows up as an unexplainable shortfall three weeks later.

### 2. The event log is append-only — never UPDATE, never DELETE

`INSERT` is the only write your code may issue against the `events` table. No `UPDATE`, no
`DELETE`, no "just fix that one row." This is the whole point of the design: history is evidence,
and evidence you can edit is not evidence.

If something was recorded wrongly, you **append a correcting event** (a `StockCounted` reset, or
a compensating `StockDepleted`). The mistake stays in the log. That is a feature — it is how a
manager can later see that the Tuesday number was wrong and when it was found.

The derived read model (`item_stock`) is different: it is disposable and may be dropped and
rebuilt from the log at any time. Only the log is sacred.

### 3. Events are versioned from day one

Every row carries `event_version` (default `1`). When a payload shape has to change, you do
**not** rewrite old rows. You:

1. bump `event_version` for newly written events,
2. add an **upcaster** on the read path that turns a v1 payload into the current shape in memory.

Readers switch on `event_version`. History is never migrated in place.

### 4. No secrets in the repo

`.env` is gitignored; `.env.example` holds local-dev placeholders only. Never commit a real
credential, and never reuse the values in `.env.example` for anything that is deployed.

## Architecture in one line

Postgres-only: an append-only `events` table plus an `item_stock` **materialized view** as the
read model. This is deliberately **not** a dual-store CQRS setup — see the README for why.

The full data contract (table DDL, event types and payloads, the read-model formula, HTTP routes
and error shape) lives in **`docs/architecture/slice-1-contract.md`**. That document is
authoritative for shapes; do not redefine those shapes locally.

## Layout

```
backend/      Node 22 + TypeScript + Express-style HTTP API, zod validation, pg. Port 3000.
frontend/     Vite + React + TypeScript. The "stock board" UI. Port 5173.
analytics/    Python notebooks + parquet exports of the read model.
infra/        Deployment scaffolding.
openspec/     Spec-driven change proposals.
docs/         Architecture docs — start with docs/architecture/slice-1-contract.md.
.claude/      Vendored Baton skill (see below).
.agents/      Run trail from agent sessions. Committed on purpose — it is a deliverable.
```

## How to run things — always via `make`

`make` is the single entry point. `make help` lists every target with a description.

| Target                   | What it does                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `make setup`             | Verify Node 22, install backend + frontend deps               |
| `make dev`               | Start Postgres, then backend and frontend together            |
| `make db-up` / `db-down` | Start / stop the Postgres container                           |
| `make db-check`          | Report which Postgres the current `DATABASE_URL` reaches       |
| `make db-reset`          | Destroy the volume and rebuild the database from migrations   |
| `make migrate`           | Apply database migrations (delegates to `backend/`)           |
| `make seed`              | Load the sample week of coffee-shop events                    |
| `make test`              | Run backend + frontend test suites                            |
| `make lint`              | Lint backend + frontend                                       |
| `make typecheck`         | TypeScript check for backend + frontend                       |
| `make analytics-export`  | Dump the read model to `analytics/data/*.parquet`             |
| `make notebook`          | Launch the analytics notebook server                          |
| `make clean`             | Remove build output and installed dependencies                |

**Node v22 is required** and this machine's default `node` is v18. Run `nvm use` first (the
version is pinned in `.nvmrc`); `make setup` fails loudly if the active Node is not 22.x.

### Running tests

```bash
nvm use
make setup      # once
make db-up      # backend tests need Postgres
make db-check   # confirm DATABASE_URL reaches the server you think it does
make migrate
make test       # backend + frontend
```

Run `make test` (or the narrower `make typecheck` / `make lint`) before you hand work back.
A change to shared code means running the full suite, not just the file you touched.

### Talking to the database

Postgres 18. There are two supported local setups — the container (default, published on host
port **5433** because 5432 is commonly taken by a native install) and a native Homebrew
`postgresql@18` on 5432. The README's "Two ways to run Postgres" section has both; `make db-check`
tells you which one your `DATABASE_URL` is actually reaching.

Container shell:

```bash
docker compose exec postgres psql -U beancounter -d beancounter
```

## Working agreements for agents

- Read `docs/architecture/slice-1-contract.md` before writing code that touches events, the read
  model, or the API. It is the shared contract across all parts of the system.
- Keep diffs surgical. Change what the task needs; don't reformat or refactor adjacent code.
- Match the surrounding style rather than importing your own conventions.
- Don't add a dependency without saying so explicitly in your summary.
- Nothing outward-facing (push, PR, tag, release) without the developer's explicit go-ahead.

## Baton (vendored)

`.claude/skills/baton/` is a **vendored copy** of the Baton skill (v1.3.4) — upstream:
<https://github.com/andrewwint/baton>. Treat it as read-only here; fix things upstream and
re-vendor rather than editing the copy. In Claude Code, invoke it with `/baton` for multi-step
work that benefits from planned lanes and review passes.
