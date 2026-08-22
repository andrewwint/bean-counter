# bean-counter

Inventory for a coffee shop, built on an **append-only event log**.

The database never stores "we have 12 kg of Yirgacheffe." It stores what *happened* — a delivery
arrived, a bag went stale, someone counted the shelf on Monday morning — and the current quantity
is derived from that history. Ask "why is this number what it is?" and the answer is a list of
events, not a shrug.

It is a starter template. Clone it, run it, and read the log.

## The build: spike, then stabilize

This repository accompanies the article
**["Your AI Code Works on the First Try. That's Why It's Not a Portfolio Project."](https://medium.com/@andrewwint/what-a-senior-engineer-actually-reads-in-your-portfolio-project-52cdfe5b41d1)**

Building a working web app with AI now takes under an hour. Generating code isn't the scarce skill
anymore — what a senior reviewer actually evaluates is engineering judgment: defending a trade-off,
naming a gap before someone else finds it, and correcting what turns out to be wrong.

**Hour 1: the spike.** Move fast to explore the domain. This repo is the result: an event-sourced
coffee-shop inventory tracker where every mutation flows through an append-only `events` log, and
current stock is folded into a disposable materialized view (`item_stock`).

**Hour 2: the stabilize.** 127 passing tests is not the finish line. Independent, cold-read
security and architecture reviews — run through [Baton](https://github.com/andrewwint/baton) —
caught real, non-syntax exposures:

- The server bound `0.0.0.0` (every network interface) while three documents claimed
  localhost-only.
- An unbounded integer quantity that, once committed to the append-only log, permanently broke the
  materialized-view refresh.
- A spec that scored an item's opening inventory count as overage rather than a baseline —
  swamping a real 350 g shortfall with a false 12 kg surplus.

**Structural enforcement beats prose.** The reviews above ran because a hook made them mandatory —
not because a document asked nicely. An instruction that exists only as a sentence in `AGENTS.md`
is exactly as reliable as any other unenforced claim in this repo (see `SECURITY.md`'s "Fixed,
with the lesson" for three more of those, found the same way).

**Use this repository:**

1. Clone it and follow the [Quickstart](#quickstart) below, then open the **Shrinkage** tab —
   that's the real inventory discrepancy the event fold exposes.
2. Read [`SECURITY.md`](./SECURITY.md) for the full audit trail: what was found, what was fixed,
   and what's still open.
3. Delete the coffee shop. Keep the harness — `.claude/`, `AGENTS.md`, `Makefile` — and build your
   own project stabilized the same way. `docs/how-this-was-built.md` has the full narrative if you
   want the mechanics of how this one got there.

## The coffee-shop analogy

Event sourcing is how a busy café already works. The vocabulary is the only new part.

| Behind the counter | In this system | Why it matters |
| --- | --- | --- |
| The **order tickets spiked at the bar** — every ticket, in the order it was rung, never pulled off and rewritten | The **event log** (`events` table, append-only) | It is the source of truth. A ticket you can edit is not evidence. Made a mistake? Spike a correction on top; the original stays. |
| The **chalkboard of what's running low**, rewritten from the tickets whenever someone glances at the spike | The **materialized view** (`item_stock`) | It's a convenience, not truth. Wipe the board and you can always rewrite it from the spike. |
| **Monday's physical count** — someone stands at the shelf with a scale and writes down what is actually there | **Reconciliation** (`StockCounted`) | The log says you should have 8 kg; the scale says 7.2. Both facts are recorded. The count becomes the new baseline and the gap is visible instead of silently absorbed. |
| "We opened a 1 kg bag, not 1 unit of bag" | **Base units** — every quantity is an integer in grams, milliliters, or each | Unit drift is the classic inventory bug. Storing `1000` grams instead of `1.0` kg means a shortfall is a real shortfall, not float rounding. |

The gap between the chalkboard and the scale is the number this system exists to show you. Most
inventory tools quietly overwrite it.

## Prerequisites

New to one of these? Click through, install it, then come back — full copy-pasteable commands
for macOS and Windows (WSL2) are in [`CONTRIBUTING.md`](./CONTRIBUTING.md#1-prerequisites-and-setup).

- [ ] **[nvm](https://github.com/nvm-sh/nvm)**, then `nvm install 22`. This repo pins **Node 22**
  (`.nvmrc`) — many machines default to Node 18, and `make setup` will stop you if the active
  version is wrong. Use `nvm`, not a plain [nodejs.org](https://nodejs.org) installer: `nvm` is
  what lets you switch to the version a project pins, instead of having one global Node everywhere.
- [ ] **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** — Postgres 18 runs in
  a container. Install it, then **make sure it's actually open and running** before you start:
  the single most common first-run failure is `make db-up` failing with a connection-refused
  error because Docker Desktop isn't running yet. (Already have a native Postgres 18 instead? See
  [Two ways to run Postgres](#two-ways-to-run-postgres) — you can skip Docker.)
- [ ] **`make`** — already installed on macOS and Linux. On Windows, it comes from WSL2/Ubuntu;
  see [CONTRIBUTING.md](./CONTRIBUTING.md#1-prerequisites-and-setup) for the two-minute setup.

## Quickstart

> **Windows:** run every command below inside a **WSL2 Ubuntu terminal**, not PowerShell —
> `make` is not a Windows command. Two-minute WSL2 + Docker Desktop setup:
> [CONTRIBUTING.md](./CONTRIBUTING.md#1-prerequisites-and-setup).

```bash
# 1. Start Docker Desktop — `make db-up` needs it running, and fails with a
#    connection-refused error otherwise.
# 2. Then, from a terminal:
nvm use                  # switch to Node 22 (see .nvmrc)
cp .env.example .env     # local-dev placeholders, safe to use as-is
make setup               # verify Node, install backend + frontend deps
make db-up               # start Postgres in Docker (needs Docker Desktop running)
make migrate && make seed  # schema + a realistic week: deliveries, a busy Saturday,
                            # one waste event, and a Monday count that comes up short
make dev                 # backend (3000) + frontend (5173)
```

Then:

- Frontend (the stock board): <http://localhost:5173>
- API: <http://localhost:3000/api/stock>

If a database result surprises you, `make db-check` reports which Postgres your `DATABASE_URL`
actually reaches.

`make help` lists every target. Everything you need to do in this repo has a `make` target.

## Two ways to run Postgres

Both are legitimate. Pick one, point `DATABASE_URL` at it, and run `make db-check` — it reports
which server actually answered, so a mismatch shows up immediately instead of as a baffling
migration error.

### 1. Container — the default, and what a fresh clone gets

```bash
make db-up               # Postgres 18 in Docker, published on host port 5433
```

`DATABASE_URL=postgres://beancounter:localdev@localhost:5433/bean_counter` (the `.env.example`
default). It publishes **5433**, not 5432, because a native Postgres install very often already
owns 5432 — change `POSTGRES_PORT` in `.env` if you want a different one. This is the portable
path and the one CI uses.

Shell into it (no host `psql` required):

```bash
docker compose exec postgres psql -U beancounter -d bean_counter
```

### 2. Native install — if you already have Postgres 18 locally

A Homebrew `postgresql@18` on the default port 5432 works fine. Skip `make db-up` and set:

```bash
DATABASE_URL=postgresql://localhost:5432/bean_counter
```

Its `psql` may not be on your default `PATH` — the Homebrew binary lives at
`/usr/local/opt/postgresql@18/bin/psql` (`/opt/homebrew/...` on Apple Silicon):

```bash
/usr/local/opt/postgresql@18/bin/psql bean_counter
```

On this project's development machine a `bean_counter` database already exists on that instance.

The database is called `bean_counter` on **both** paths (the role stays `beancounter`), so
migrating one and inspecting the other cannot quietly show you stale data. Tests use a separate
`bean_counter_test`.

## Folder map

```
backend/     Node 22 + TypeScript API. Appends events, serves the read model. Port 3000.
frontend/    Vite + React + TypeScript. The stock board and the entry forms. Port 5173.
analytics/   Python notebooks + parquet exports of the read model.
infra/       Deployment scaffolding.
docs/        Architecture. Start with docs/architecture/slice-1-contract.md.
openspec/    Spec-driven change proposals.
.claude/     Vendored Baton skill (see AGENTS.md).
.agents/     Session-scoped scratch trail from agent runs — gitignored, not a deliverable.
             SECURITY.md is the authoritative security record.
```

- **`AGENTS.md`** is the single source of truth for working in this repo (rules, targets, tests).
  `CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers to it.
- **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** — setup, migrations, testing expectations, what CI
  actually runs, and commit conventions.
- **[`SECURITY.md`](./SECURITY.md)** — the posture, the known open issues, and the findings that
  were already fixed. **Read it before you deploy this anywhere:** the API has no authentication
  of any kind, and the CDK stack would publish it over plaintext HTTP.
- **`docs/architecture/slice-1-contract.md`** is the data contract: table DDL, event types, the
  read-model formula, the HTTP API.
- **[`docs/how-this-was-built.md`](./docs/how-this-was-built.md)** — the build narrative: the
  CQRS-vs-single-Postgres decision, what independent review found, and a from-scratch setup guide.

## The architecture decision: Postgres only

**One Postgres database holds both the event log and the read model.** The log is the `events`
table; the read model is an `item_stock` materialized view refreshed after each append. This is
explicitly **not** a dual-store CQRS setup — there is no separate read database, no message bus,
no projection worker.

That is a deliberate trade, and the honest version is this. A dual-store design buys you
independent read scaling, which a coffee shop with a few hundred events a day does not need, and
charges for it in failure modes: two datastores that can disagree, a projection worker that can
fall behind or die, and a UI that shows a number which was true four seconds ago. Keeping it in
one database means one thing to run, one thing to back up, one failure mode, and a write and its
projection that either both commit or both roll back — so there is no projection lag to explain to
anyone. The cost is real: `REFRESH MATERIALIZED VIEW` gets slower as history grows, and writes pay
for it synchronously. The reason that cost is affordable is that **the read model was never the
source of truth**. It is derived, disposable, and rebuildable from the log at any time. When the
refresh becomes the bottleneck, you swap the materialized view for an in-transaction projection
table — or, later, an out-of-process projector — without touching a single stored event. The
expensive thing to get wrong is the log, and the log is append-only from day one.

## What's deliberately not here yet

This is a starter, and the omissions are as considered as the inclusions:

- **Auth and roles.** No login, no barista-vs-manager permissions. Every write is anonymous.
  Real deployments need at minimum a manager role gate on `StockCounted`, since a count overwrites
  the baseline. This is the first item in [`SECURITY.md`](./SECURITY.md), which also lists the
  other known exposures and the checklist to work through before deploying.
- **Recipe / BOM depletion.** Selling a latte does not automatically deplete 18 g of beans and
  240 ml of milk. Depletion is recorded directly. Recipe-driven depletion is the natural next
  slice and the event log is already the right shape for it.
- **Offline-first at the counter.** The UI needs the network. A café's Wi-Fi does not care about
  that. The real answer is a local SQLite log that syncs to the server log — which append-only
  event storage makes tractable, because merging two append-only logs is ordering, not conflict
  resolution.

## License

MIT — see [LICENSE](./LICENSE).
