## Context

A manager counting the stockroom shelves is standing in the worst-connected corner of the building
holding a tablet. The count has to survive that. This proposal puts a local SQLite database on the
tablet to hold captured counts until they can be synced.

## The honest reason SQLite is here

SQLite shows up in projects like this one for the wrong reason roughly every time: someone proposes
it as a read cache in front of Postgres, to "make the stock board faster." That would be a mistake
here, and it is worth writing down so the idea does not come back wearing a different hat.

Caching the read model in SQLite would create **a second store that can disagree with the log**. The
entire architecture of bean-counter rests on there being one source of truth and one derivation from
it — that is why `item_stock` is disposable, why the projection swap in `add-projection-table` is
cheap, and why "rebuild from the log" is always a valid answer. A read cache buys a performance win
this system does not need (one shop, a few thousand events) and pays for it with a class of bug that
is genuinely hard: two numbers, both plausible, and no principled way to say which is right.

The offline count is different in kind. It is not a copy of server state — it is **state the server
does not have yet**. The count exists only on the tablet because it was taken in a place where the
server could not be reached. There is no disagreement to arbitrate, because there is nothing to
disagree with: the local store holds facts in flight, not a duplicate of facts already recorded.
That is the shape SQLite is genuinely good at, and it is the only role it takes on here.

The rule this proposal commits to: **SQLite is an outbound queue and a display cache, never an
authority.** If a queued count has synced, the tablet's copy is disposable. If the tablet is lost
after a successful sync, nothing is lost. That is the test for whether this stays honest.

## Goals / Non-Goals

**Goals**
- A full count completes with no connectivity, and nothing is lost.
- The count's `occurredAt` is when it was taken, not when it arrived.
- Sync is idempotent — a retry cannot double-record a count.
- Pending state is visible, so an unsynced count is never mistaken for a recorded one.

**Non-Goals**
- Offline *reads* of the stock board as an authoritative view. Cached display only, clearly labelled.
- Peer-to-peer or multi-tablet sync. One tablet, one server.
- Automatic conflict resolution. Conflicts are surfaced to a human.
- Offline capture of receiving or waste events. Counting is the flow with the connectivity problem;
  the rest happens at the register where the wifi works. Expandable later if the need is real.

## Decisions

### Decision 1: the tablet generates `eventId` at capture time

The uuid is created when the manager records the number, not when the sync runs. This is what makes
sync idempotent for free — the server's existing `event_id UNIQUE` constraint becomes the dedupe key.
The append path only needs to change in how it *reports* a duplicate: a repeat `eventId` is an
idempotent success (return the existing `sequence`), not a `409` and not an unhandled unique
violation. No new dedupe table, no client-side sequence numbers.

### Decision 2: `occurredAt` from the tablet clock, `recordedAt` from the server

The contract already separates these two columns, which is precisely the affordance needed here. The
fold orders by `sequence` (arrival), while `occurredAt` tells the human when it actually happened.
A count that syncs an hour late lands late in the log's order but reads correctly in the history.

**Risk accepted:** the tablet clock can be wrong, and `occurredAt` is therefore attacker- and
accident-influenced. Given `add-auth-and-roles` restricts counting to managers and stamps the actor,
this is a bounded exposure — but a wildly skewed clock should be flagged at sync (server compares
`occurredAt` to now and warns on an implausible gap) rather than trusted silently.

### Decision 3: append the count even when stock moved in between; do not auto-resolve

If beans were depleted between capture and sync, the count is still true — it was true at 08:15. The
system appends it and *tells the manager* what happened in the gap. Auto-adjusting the counted
quantity by the intervening deltas would be inventing a number nobody observed, which is exactly the
failure mode the append-only design exists to prevent. Show the evidence; let a human decide whether
to count again.

### Decision 4: the queue drains oldest-first, and rows leave only on confirmation

Standard outbox semantics. A row is deleted after a `201` or a confirmed duplicate; anything else
leaves the row in place with `last_error` recorded. A terminal failure (`403`, `400`) stops the retry
loop and surfaces to the user — retrying a validation failure forever is a silent data-loss bug
wearing a progress spinner.

## Risks / Trade-offs

- **SQLite quietly becoming a read cache.** The most likely way this design decays. → The spec pins
  it with a requirement ("the local store is a queue, not a source of truth") including a scenario
  that the tablet adopts server values on disagreement. It is checkable, not just stated here.
- **Tablet clock skew** poisoning `occurredAt`. → Flag implausible gaps at sync; the actor stamp from
  `add-auth-and-roles` bounds who can do it.
- **A stale item cache** means counting an item that was renamed or retired. → The cache carries its
  own sync timestamp and the count screen shows how old it is.
- **A queued count sitting unsynced for days** while the manager believes it was recorded. → The
  pending-state requirement exists for exactly this; age of the oldest pending item is displayed.

## Migration Plan

Purely additive; no server schema change beyond the idempotent-append behavior, which is backward
compatible (a first-time `eventId` behaves exactly as today).

1. Ship the idempotent append on the backend. Nothing else changes.
2. Ship the local store and offline capture behind a flag, defaulting off.
3. Ship the sync worker and pending-state UI; enable for the counting tablet.

**Rollback:** disable the flag. Queued counts drain first; the tablet falls back to online-only
capture. No server state to unwind.

## Open Questions

- Does the tablet need to work offline for *receiving* deliveries too? A delivery arrives at the back
  door, which has the same wifi problem. Deferred until someone asks — the mechanism generalizes.
- How long may a count sit queued before the system escalates rather than merely displaying age?
- Should the server reject a `StockCounted` whose `occurredAt` predates the item's last count by more
  than some window, or accept it and let the fold's sequence ordering sort it out? Currently the
  latter, which is consistent with "the log holds what was claimed."
