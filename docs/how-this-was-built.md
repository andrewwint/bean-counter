# An Event-Sourced Inventory Starter Kit, Built by Five AI Agents

Event-sourced Postgres, CDK, CI, and a Python notebook — scaffolded by parallel agents,
reviewed by others.

In an interview you are going to be asked how you use AI responsibly. Probably in a screen,
definitely by the third round, and increasingly by people who have watched a lot of candidates
fail the question.

Most answers are the same three sentences. I use it as a starting point. I always review the
output. I don't just copy and paste. All true, all unfalsifiable, and all indistinguishable from
what someone says who does none of it.

So here's a different answer. Point at a repo and say: I built this in about two hours with AI
agents. Roughly the first hour was building. The rest was independent review, and here's what it
found in code that already had 127 passing tests. Then list them — an API open to anyone on the
network, a request that could break the system permanently, a number that was wrong because of how
I'd worded a spec.

## What a senior reviewer actually reads

They're looking for three things.

- **A decision you can defend.** Not which stack you picked. Whether you chose between two
  reasonable options and can say what the other one would have bought you. A repo where every
  choice is the default choice shows no judgment, because defaults require none.
- **Gaps you already named.** A project with gaps looks unfinished. A project with named gaps
  looks scoped. If a reviewer finds a missing piece you documented, that's discipline. If they
  find one you didn't, they're now wondering what else you can't see.
- **Something that went wrong.** They've seen a hundred projects where everything worked, which
  gives them nothing. What they need to know is how you behave when what you built turns out to
  be wrong — because that's the job. Not building. Correcting.

## The Starter-kit tour

Here it is, unedited, typos included:

> /baton I would like to create a project located ../projects where it would be starter project
> for an inventory management system that will be self contained with AI skills copy of baton if
> claude code is use, generic coding skill for github copilot or codex. The app should include
> openspec for planning, infrastructure folder for CDK, backend or frontend if we use vite for
> nextjs, and analytics folder to run data anaylsis with a python notebook, I assume postgress
> should be the local database.
>
> Should we start with CQRS maybe with SQLite for read cache then Postgress for event long and a
> materilized veiw for get the latest version of the item. Also a root Makefile?
>
> What am I missing from the high level plan, in ./projects/<project-name> you can do the base
> stepup.
>
> Also the preson using this plans to use this as a coffee shop inventory system so we can hint to
> the end solotion and options and trade offs. Since coffee is often used in software as a teaching
> aid it could be an analogoy.
>
> What do you think, the above is the highlevel we can take the building in slices, and have the
> claude agent in the target folder do the heavy lifting as you review and guide

Here's what came out. One line on each piece that isn't obvious — the obvious ones need no
explanation.

```
backend/      Node 22 + TypeScript. Appends events, serves the read model.
frontend/     Vite + React. The stock board and entry forms.
analytics/    Python notebooks reading a Parquet snapshot, not the live database.
infra/        AWS CDK. Synth-only — deliberately never deployed.
migrations/   Every schema change, in order, replayable from empty.
openspec/     Change proposals. The roadmap, in a format an agent can read.
.agents/runs/ Session-scoped run trail from agent sessions. Gitignored scratch, not a deliverable.
AGENTS.md     The single source of truth for working in this repo.
SECURITY.md   The posture, the known gaps, and what review already found.
Makefile      Every target you'd need to do has one.
```

`migrations/` — a schema you can't rebuild from empty isn't a schema, it's a machine you got
lucky on.

`docker-compose.yml` — Postgres in a container on 5433, not 5432, because a native install
usually already owns 5432. Small thing that says someone handed this to another person.

`analytics/` reading Parquet — analysis shouldn't be able to lock or slow the thing serving the
app.

`infra/` synth-only — the CDK stack builds and is never deployed, and the README says why: it
would publish an unauthenticated API over plaintext HTTP. Shipping infrastructure you haven't
hardened is worse than not shipping it.

`.agents/runs/` — every session's own scratch trail of what it planned, changed, and verified,
kept local. It is deliberately **not** the thing you'd point a reviewer at — it's session-scoped
and best-effort, never authoritative for a security disposition. `SECURITY.md` is the record that
is; the run trail almost shipped as a committed "deliverable" instead, which would have been the
same mistake as the LAN-binding bug below in a different costume: a claim in prose, unenforced.

`AGENTS.md` as the single source — `CLAUDE.md` and `.github/copilot-instructions.md` are
three-line pointers to it. Three tools, one set of rules.

`Makefile` — `make dev` runs everything. A reviewer who needs three files to start your project
usually stops.

<!-- VIDEO EMBED: https://youtu.be/KKZBfCpdpmo -->
[▶ Watch the build](https://youtu.be/KKZBfCpdpmo)

## A decision, written down

Most portfolio projects store the current state. A table with an `items` row, a quantity column,
and an update every time something changes. That's CRUD, and it's the right default for most
things.

This one stores what happened instead. A delivery arrived. A bag went stale. Someone counted the
shelf on Monday. The current quantity isn't stored anywhere — it's derived by adding up the
history. That's an event log with a read model on top, the shape usually called CQRS.

Why it matters for a coffee shop: the log says you should have 8 kg, the Monday scale says 7.2.
Both facts get recorded, and the gap is visible. A CRUD table would overwrite the 8 with the 7.2
and the shrinkage would vanish. That gap is the number the system exists to show.

Now the decision, which is the part worth copying.

The original plan called for two databases — SQLite as a read cache, Postgres as the event log.
That's the textbook CQRS setup. I argued against it, and the README says why in full. The short
version:

A dual-store design buys independent read scaling, which a coffee shop with a few hundred events a
day does not need, and charges for it in failure modes: two datastores that can disagree, a
projection worker that can fall behind or die, and a UI showing a number that was true four
seconds ago.

One Postgres holds both — the `events` table is the log, a materialized view is the read model,
refreshed in the same transaction as the append. One thing to run, one thing to back up, one
failure mode, and no projection lag to explain.

The cost is stated, not hidden. `REFRESH MATERIALIZED VIEW` gets slower as history grows, and
writes pay for it synchronously. That's a real bill.

And the trigger is named. When the refresh becomes the bottleneck, swap the view for an
in-transaction projection table, or later an out-of-process projector — without touching a single
stored event. The expensive thing to get wrong is the log, and the log is append-only from day
one.

That's the shape. Four parts:

1. What you chose
2. What the alternative would have bought you
3. What your choice costs
4. What would make you revisit it

The fourth is the one that separates a decision from a preference. Anyone can prefer Postgres.
Saying here's the condition under which I'd change my mind is what tells a reviewer you understood
the trade rather than picked a side.

## The turn (skim this section)

At 55 minutes the app worked. 127 tests passing, CI green, the board rendering.

That's where a build video normally ends.

<!-- VIDEO EMBED at 55:00 -->
[▶ Watch at 55:00 — the turn](https://www.youtube.com/watch?v=KKZBfCpdpmo&t=3300s)

What happened next wasn't my idea. The orchestrator's own rules required it: any change touching a
security or access-control surface gets an independent review, and at least one reviewer gets a
cold read — the spec and the diff, none of my hypotheses about where the problem is.

Ten exposures were recorded across three sources with no overlap between them. Three worth your
time:

**The app was open to anyone on the wifi.** The server was started without a hostname, so it
listened on every interface. The README said localhost only. The route comment said localhost
only. The console said localhost only. Nothing in the code did. I read the full inventory and
appended an event from another machine on the network, on camera.

**One request could break it permanently.** The validator checked that quantity was an integer —
correct, and unbounded. A quantity of `1e19` passed validation, committed to the append-only log,
and then overflowed when the read model tried to fold it. After that the view can never refresh,
so every subsequent write fails and the board is frozen. It's permanent for two reasons: the log
is append-only by design, and the fix can't be applied retroactively, because adding the
constraint validates existing rows. Recovery is recreating the database.

**A number was wrong, and my spec caused it.** Not ambiguity — the spec was precise and complete.
It just omitted a case: the first count of an item, when the log knows nothing about it. Expected
zero, counted 12 kg, so the formula scored opening inventory as a 12 kg overage and swamped the
real 350 g shortfall. An opening count is a baseline, not a variance. I found this one myself,
after both reviews passed, by comparing the endpoint's output against what I knew was in the seed
data.

The full list is in [`SECURITY.md`](../SECURITY.md) and the run's disposition record.

Notice what each has in common. The first: three documents asserted a control that no code
implemented. The second: a validator right about type and wrong about range. The third: a spec
that was clear and incomplete. None is a coding error, and none is fixed by being more careful.

All three were found by something that hadn't written the code. That's the whole mechanism, and it
costs one command.

## I asked it why (skim this section)

After the fixes I asked the orchestrator what made it run those reviews. I hadn't asked for them.

Three rules in the skill fired, and they're worth stealing regardless of tooling:

- A change touching security or access control goes to an independent review — and having no
  separate work to split is explicitly not a reason to review it yourself.
- Seam-defining changes get two review lenses, at least one of them a cold read.
- The seam gets recorded to a file before implementation, or a completeness check downstream never
  arms.

That's why the three sources of findings had zero overlap.

Then it found a miss. The repo's `AGENTS.md` says to route reviews to dedicated skills when
they're installed. They were installed. It never read the file — and only noticed when I asked.

Its own explanation:

> The seam-recording obligation fired because there's a hook behind it. The review-composition
> preference didn't fire because nothing checks it. Same session, two obligations — the structural
> one held and the prose one didn't.

Same shape as the LAN exposure: three documents claimed localhost-only and no code enforced it.

The fix isn't a firmer sentence in `AGENTS.md`. It's a check at the verify step that fails loudly
when the lane didn't route correctly.

## What you do after the prototype — one-shot prompt to spec-driven development

The one-shot got you a scaffold. It doesn't get you a second feature, and this is where most
projects stall — you have something that works, no idea what's next, and every change risks
breaking what's there.

The cycle is three steps and it doesn't need my tooling.

**Plan.** Write the change before you build it. What you're adding, what done looks like, what's
out of scope. I use OpenSpec because proposals are structured enough for an agent to read and
track, but a `PLAN.md` works. The repo has four proposals queued this way:

```
add-offline-counter-sqlite   0/21 tasks
add-projection-table         0/17 tasks
add-auth-and-roles           0/22 tasks
add-recipe-bom-depletion     0/20 tasks
```

Eighty tasks, none complete. That's a roadmap a reviewer can read — and it's more informative than
a finished feature, because it shows you know what the project needs.

**Implement.** One slice at a time. Small enough that you can read every line of the diff, because
you're going to have to.

**Review.** Hand the diff to something that didn't write it. `/code-review` and `/security-review`
ship with Claude Code. Give the reviewer the spec and the diff and nothing else — no hints about
where you think the problem is, because a hint is just your own suspicion handed forward.

Then commit, and start again.

That's it. Plan, implement, review, one slice at a time. All of the review discipline in the last
two sections came out of that loop, and the loop is four lines in a config file.

One note on ordering. The reviews, the fixes, the roadmap, and a green pipeline all happened in
the same stretch — the second hour, after the app already worked. The building was the fast part.
It always is.

## Where to start — hands on

Everything above is checkable. Here's the fastest path to having it running locally.

### Prerequisites

Node 22 is required, not recommended — `make setup` refuses to run on anything else, because the
tooling rejects older versions.

**macOS:**

```bash
# Homebrew first, if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node 22 via nvm (do NOT brew install node — the pin matters)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22

brew install --cask docker      # provides Postgres 18 via compose
brew install postgresql@18      # optional, but gives you the psql client
brew install python@3.13 gh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

`psql` may not land on your `PATH`. If `which psql` comes up empty:

```bash
echo 'export PATH="/usr/local/opt/postgresql@18/bin:$PATH"' >> ~/.zshrc
```

**Windows:**

Use WSL2. The repo drives everything through a Makefile, and `make` isn't native to Windows.
Docker Desktop uses WSL2 as its backend anyway.

```powershell
wsl --install -d Ubuntu           # PowerShell, as Administrator
```

Then install Docker Desktop, enable Settings → Resources → WSL Integration for your distro, and
run the macOS commands above inside the WSL terminal — plus `sudo apt install -y make`.

```bash
sudo apt update && sudo apt install -y make build-essential python3 python3-pip gh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo apt install -y postgresql-client-common postgresql-client   # psql only; server runs in Docker
```

Keep repos on the Linux filesystem (`~/code/...`), not `/mnt/c/...` — file watching and npm
installs are dramatically slower across the mount.

Verify before you clone anything:

```bash
node -v      # v22.x
docker info  # daemon running
python3 -V   # 3.x
uv --version
```

`nvm use` is not automatic in a new terminal. Most confusing first-day failures trace back to that
one line.

### Get the code

Fork it if you plan to build on it. You want your own history:

```bash
gh repo fork andrewwint/bean-counter --clone
cd bean-counter
```

Clone it if you just want to read and run:

```bash
git clone https://github.com/andrewwint/bean-counter.git
cd bean-counter
```

### First run

```bash
nvm use                  # switches to Node 22 from .nvmrc
cp .env.example .env     # local-dev placeholders, safe as-is
make setup               # verifies Node, installs backend + frontend
make dev                 # Postgres + backend (:3000) + frontend (:5173)
```

Then in a second terminal:

```bash
make migrate             # creates the events table and the read model
make seed                # loads the sample coffee-shop week
```

Open <http://localhost:5173>. You should see a stock board with seven items. Switch to the
Shrinkage tab: Whole Milk is short 0.9 L, Yirgacheffe short 350 g. That gap is seeded
deliberately — it's the question the whole app exists to answer.

### When it breaks

- **`ERROR: Node 22.x is required`** — you skipped `nvm use`. It isn't automatic per terminal.
- **Port 5432 already in use** — you have a local Postgres. The container publishes 5433 on
  purpose. Run `make db-check`; it reports which Postgres your `DATABASE_URL` actually reaches,
  which is the single most confusing failure in this stack.
- **Board shows "internal error"** — the frontend is up and the API isn't. Check `make db-up`
  succeeded and Docker is running.
- **Stale data after pulling** — `make db-reset && make seed`.

### Then point an agent at it

The repo ships one rulebook read by three tools. `AGENTS.md` is the source; `CLAUDE.md` and
`.github/copilot-instructions.md` are pointers that never restate it, so they can't drift.

With Claude Code, Baton is vendored at `.claude/skills/baton/`. Start with a tour:

```
/baton read AGENTS.md and docs/architecture/slice-1-contract.md, then give me a
tour of this repo: where the event log lives, how item_stock is derived, and
what the four openspec proposals are for
```

Then pick real work — the proposals are already specced:

```
/baton implement openspec/changes/add-recipe-bom-depletion. Read its design.md
first; the recipe-version pinning decision is load-bearing. Run verification in
its own lane.
```

With Copilot or Codex, they read `AGENTS.md` automatically. Point them at the contract and the two
rules that can't be broken:

> Read AGENTS.md and docs/architecture/slice-1-contract.md before changing anything.
> Quantities are integers in a base unit. The events table is append-only.

Those two rules are worth understanding before you touch anything. Quantities are integers in a
base unit — grams, millilitres, or "each," never floats, converted only at the display edge. Store
`12.0` and your counts drift; store `12000` and a shortfall is a real shortfall. `events` is
append-only — never `UPDATE`, never `DELETE`. Made a mistake? Append a correcting event. The
original stays. That's what makes the log evidence rather than an opinion.

And read [`SECURITY.md`](../SECURITY.md) before you deploy anything anywhere. It's short, and its
"Fixed, with the lesson" section is the most useful document in the repo if you're extending the
template.
