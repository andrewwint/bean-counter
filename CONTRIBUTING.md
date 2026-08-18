# Contributing to bean-counter

Read [`AGENTS.md`](./AGENTS.md) first. It is the single source of truth for how this repo works —
the domain rules, the `make` targets, and the data contract. This file covers the mechanics of
getting set up and getting a change merged, and points back at `AGENTS.md` rather than restating
it.

Read [`SECURITY.md`](./SECURITY.md) too, before you touch the API or `infra/`. The template ships
with known, documented exposures.

## 1. Prerequisites and setup

**Node 22** is required and pinned in `.nvmrc`. Many machines default to Node 18, and Vite 6+ /
Next 15+ reject it outright — usually with an error that does not say "wrong Node version."

```bash
nvm use                  # switch to the pinned Node 22
cp .env.example .env     # local-dev placeholders, safe as-is
make setup               # verifies Node 22, then installs root + backend + frontend deps
```

`make setup` runs `make check-node` first and fails loudly with the `nvm use` hint if the active
Node is not 22.x. You can run that check on its own:

```bash
$ make check-node
Node v22.13.1 OK
```

`make help` lists every target. Everything you need to do in this repo has one.

### Know which Postgres you are talking to

Two Postgres installs on one machine is the normal case, not the odd one: a native Homebrew
`postgresql@18` usually owns **5432**, so the compose container publishes **5433** to stay out of
its way. Both are supported. The failure mode is running migrations against one and reading from
the other, which looks like "my data vanished."

```bash
make db-up               # start the container (published on 5433)
make db-check            # report which server DATABASE_URL actually reached
```

`make db-check` connects with the real `DATABASE_URL`, prints the server version it got back, and
says whether that server is the compose container or something else:

```
DATABASE_URL -> localhost:5433/bean_counter
Connected. Postgres 18.6 (Debian 18.6-1.pgdg13+2)
This is the bean-counter container (compose service 'postgres').
```

Run it whenever a database result surprises you. If no `psql` is on your `PATH` it falls back to
querying the container directly and tells you that it did so — which is a different question, so
read the note it prints.

Then:

```bash
make migrate
make seed                # a realistic week of events, including a count that comes up short
make dev                 # Postgres + backend (3000) + frontend (5173)
```

## 2. Two domain rules that are not negotiable

Stated once here; [`AGENTS.md`](./AGENTS.md) has the full version with the reasoning and the unit
table.

1. **Quantities are integers in a base unit** — grams, milliliters, or `each`. Never floats, never
   mixed units. Conversion to human-readable units (kg, L) happens in exactly one place: the UI
   formatting layer. The API speaks base units only. A float in a quantity field is a bug.

2. **`events` is append-only.** `INSERT` is the only write your code may issue against it. Never
   `UPDATE`, never `DELETE`, not even to "just fix that one row." A mistake is corrected by
   appending a compensating event (a `StockCounted` reset or an offsetting `StockDepleted`); the
   original stays, because history you can edit is not evidence. The derived `item_stock` read
   model is the opposite — disposable, droppable, rebuildable from the log at any time.

A change that violates either rule will not be merged, however green the tests are.

## 3. Migrations

Migrations are **numbered plain `.sql` files** in `backend/migrations/`, applied in filename order
by `backend/src/migrate.ts` (`make migrate`). Plain SQL is deliberate: a reader can open
`002_item_stock.sql` and see the fold. An ORM would hide the thing this project exists to show.

Rules:

- **Each migration must be idempotent.** The runner records applied filenames in
  `schema_migrations` and skips them, so `make migrate` is safe on every boot — but write the SQL
  so that re-running it is also safe (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`s; see
  `003_quantity_bounds.sql` for the pattern).
- **Never edit an already-applied migration.** It will not re-run on any database that already has
  it, so you would produce two schemas that share a version number. Adding a new numbered file is
  the only path.
- Each file runs in its own transaction — it lands whole or not at all.

## 4. Testing expectations

```bash
make test        # backend + frontend
make typecheck   # tsc --noEmit, both workspaces
make lint        # eslint, both workspaces
```

Backend tests run against a **real Postgres** — no mocks. `backend/test/global-setup.ts` creates
its own database (`DATABASE_URL_TEST`, default `bean_counter_test`), migrates it, and drops it
again at the end, so the suite never touches your dev data. `backend/vitest.config.ts` overwrites
`DATABASE_URL` with the test URL for the duration of the run.

Do not mock the event store. A mocked store tests our belief about the SQL, not the SQL that ships
— and every interesting bug in this system so far (an overflowing `::bigint` in the materialized
view, a fold that disagreed with the log) lived in the SQL.

Both workspaces' `test` scripts are `vitest run` — **non-watch on purpose**, because CI invokes
them and a watcher would hang the job. Use `npm run test:watch --prefix frontend` locally if you
want a watcher; add an equivalent script rather than changing `test`.

**Weakening, skipping, or deleting a test to make a suite green is not an acceptable fix.** If a
test fails, either the code is wrong or the test encodes a rule we have decided to change — and the
second one is a conversation in the PR, not a `.skip` in the diff. Changing an assertion to match
observed behavior is the same move wearing a different hat.

Run the full suite, not just the file you touched, when you change shared code.

## 5. CI/CD

### What CI actually does

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request. One job, `build`, on
`ubuntu-latest`:

- **Node** comes from `.nvmrc` via `actions/setup-node@v4` (`node-version-file: .nvmrc`, npm cache
  on) — so the pin is in one place and CI cannot drift from local.
- **Postgres** runs as a **service container** (`postgres:18`, user `beancounter`, database
  `bean_counter`, published on 5432) with a `pg_isready` health check, so the job waits for a
  database that can actually answer.
- **Steps, in order:** install (`npm install` at the root and with `--prefix backend` /
  `--prefix frontend`) → typecheck both workspaces → lint both workspaces →
  `npm run migrate --prefix backend` → `npm test` for backend then frontend.

Two environment variables are set at job level, and the second one is load-bearing:

```yaml
DATABASE_URL:      postgres://beancounter:localdev@localhost:5432/bean_counter
DATABASE_URL_TEST: postgres://beancounter:localdev@localhost:5432/bean_counter_test
```

`DATABASE_URL_TEST` **must** be set. `backend/vitest.config.ts` overwrites `DATABASE_URL` for the
test run with `DATABASE_URL_TEST`, whose default (`postgresql://localhost:5432/bean_counter_test`)
carries no credentials — and on a runner the OS user is `runner`, for whom the service container
has no role. This was a real bug: CI looked green-ish while the backend suite could not connect to
the database at all. If you change how the test database is selected, change it in CI too.

### What CI does not do

- **`infra/` is not covered.** No `cdk synth`, no typecheck, no test. Run `make infra-synth`
  locally after touching it. (It renders the template offline and never calls AWS.)
- **`analytics/` is not covered** by this workflow either.
- **There is no CD pipeline.** Nothing deploys, on any branch, ever. Deployment is manual, has
  never been performed from this repository, and is gated on the open issues in
  [`SECURITY.md`](./SECURITY.md) — in particular that the application has no authentication and the
  CDK stack would publish it over plaintext HTTP. `cdk synth` is the only infra command that is
  safe to run casually. See `infra/README.md`, which also has the monthly cost warning.

## 6. Branches and commits

Commit messages follow the Conventional Commits style already in the history — a type, an optional
scope in parentheses, and an imperative subject on one line:

```
fix(ci): set DATABASE_URL_TEST so the backend suite can connect
feat(infra): build backend Fargate image from backend/Dockerfile
chore(db): standardize database name to bean_counter
```

Types in use: `feat`, `fix`, `chore`. Scopes match the directory or subsystem you touched
(`backend`, `ci`, `infra`, `analytics`, `make`, `db`). Say what changed and, where it is not
obvious, why — the messages above are the standard to match.

The history is currently linear on `main` and records no branch-naming convention, so there is
nothing to match there yet: keep branches short-lived, name them after the change, and rebase
rather than accumulating merge commits.

Keep diffs surgical — change what the task needs, and do not reformat or refactor adjacent code
along the way. Before you hand work back, run `make test` (or at least `make typecheck` and
`make lint`).

**Nothing outward-facing without the maintainer's explicit go-ahead** — no push to `main`, no tag,
no release, no deploy.

## 7. Working with AI agents on this repo

[`AGENTS.md`](./AGENTS.md) is the single source of truth for agents as well as humans. Codex and
GitHub Copilot read it natively; `CLAUDE.md` and `.github/copilot-instructions.md` are thin
pointers to it. **If a rule matters, write it in `AGENTS.md` once** — three parallel instruction
documents drift by week three, and then nobody knows which one is lying.

`.claude/skills/baton/` is a **vendored copy** of the Baton skill
(<https://github.com/andrewwint/baton>). Treat it as read-only here: fix things upstream and
re-vendor rather than editing the copy.

When you re-vendor it — or vendor anything else — **exclude `.env`**. A copy that excluded only
`.git` once brought a live API key into this tree. See the first entry under "Fixed, with the
lesson" in [`SECURITY.md`](./SECURITY.md).

`.agents/` holds each session's scratch run trail and is gitignored — local working state, not a
deliverable. It is session-scoped and best-effort and is never authoritative for a security
disposition; [`SECURITY.md`](./SECURITY.md) is.
