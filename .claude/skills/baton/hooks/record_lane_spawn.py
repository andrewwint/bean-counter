#!/usr/bin/env python3
"""PostToolUse sidecar: record REAL subagent (Task/Agent) spawns to a ledger the disposition
deriver trusts at run time.

Wire as a Claude Code PostToolUse hook alongside the Stop hook (see SKILL.md / settings.json):

  {"hooks": {"PostToolUse": [{"matcher": "Task|Agent",
      "hooks": [{"type": "command",
                 "command": "python3 .claude/skills/baton/hooks/record_lane_spawn.py"}]}]}}

The matcher MUST cover both tool names: baton spawns lanes via the tool exposed as `Agent` in some
Claude Code builds and `Task` in others (the runtime handles both — orchestrator.ts). A `Task`-only
matcher silently never fires for `Agent`-named spawns, leaving the ledger empty; under active
enforcement that over-fires every genuine contract to UNVERIFIED-SEAM.

WHY THIS EXISTS. `disposition.json` is model-authored, so a `contract_source: "specialist"` can be
FABRICATED — the model claims an independent specialist contract with no real lane behind it. The
Stop-hook deriver cannot disprove that from the record alone, and the Stop-time transcript is
unreliable (a run-time-vs-post-hoc divergence: the subagent's `task_started` is not reliably present
at stamp time). Until now, only the eval's POST-HOC scorer caught fabrication — a bare install had no
run-time defense.

This hook REDUCES that gap (it does not close it — see the trust boundary) with a signal the model
CANNOT forge by NARRATING: it fires only on an actual `Task`/`Agent` tool-use, and appends the spawned
lane (its `subagent_type`, and `task_id`/`id` when the response carries one) to
`.agents/runs/lane_spawns.jsonl`. The deriver then honors a claimed specialist contract only when it
matches a lane really recorded here. A genuine consult is recorded → honored (no over-fire); a
fabricated claim has no record → downgraded to UNVERIFIED-SEAM. It does NOT close the gap: `subagent_type`
is model-authored, so a no-op consult still forges a qualifying spawn, and the session-scoped ledger has
no seam binding — the post-hoc scorer (did the lane do real work) stays authoritative.

TRUST BOUNDARY, STATED HONESTLY. This proves a lane *spawned*, not that it did good work — depth still
lives in the specialist lane and in the post-hoc scorer. It shrinks the run-time trust surface from
"trust the model's narration in disposition.json" to "trust the tool-use hook" — a real reduction, not
elimination. Scope is the session's runs root (`.agents/runs/lane_spawns.jsonl`), not a single runId:
correlating a PostToolUse event to baton's runId without model cooperation is not reliable, and a
session-scoped ledger already answers the only question the deriver asks — "did an independent lane
really spawn." In a hermetic eval trial (one run per workspace) session-scope IS run-scope.

Never blocks: this hook only records. Exit 0 always (a recording failure must not break a tool-use);
a corrupt ledger is rebuilt on the next write.
"""
import json
import os
import sys

# Append-only JSONL (one spawn object per line). Append-only is deliberate: parallel lanes fire this
# hook as separate processes, and a read-merge-replace would lose spawns to last-writer-wins. A single
# short `open(..., "a")` line write does not have that race.
LEDGER = os.path.join(".agents", "runs", "lane_spawns.jsonl")

# Kept in lockstep with disposition_gate.GENERIC_SUBAGENTS — recorded here faithfully regardless; the
# deriver applies the independence filter. We record ALL spawns so the ledger is a truthful spawn log.


def read_event():
    """Return the PostToolUse stdin JSON, or {} if none/unparseable."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}


def spawn_from_event(event):
    """Extract {subagent_type, task_id} for a Task/Agent tool-use, or None for anything else."""
    if event.get("tool_name") not in ("Task", "Agent"):
        return None
    tool_input = event.get("tool_input") or {}
    subagent_type = tool_input.get("subagent_type")
    if not subagent_type:
        return None
    resp = event.get("tool_response") if isinstance(event.get("tool_response"), dict) else {}
    # The stable spawn id. Probed from real PostToolUse payloads (2026-07): the id IS on this event —
    # `tool_response.agentId` (the spawned lane's id, e.g. "ad649f55b990c6d22", the same value the Agent tool
    # returns and that a manager would cite in `contract_lane`), with top-level `tool_use_id` ("toolu_…") as a
    # fallback. (Earlier code looked for `task_id`/`id` and found null — a WRONG-KEY bug, not a payload gap.)
    # A populated id lets the ledger de-duplicate a double-fired spawn and lets the deriver's substring match
    # bind a cited id; it stays a SECONDARY signal to non-generic `subagent_type`, never the sole certifier.
    task_id = (resp.get("agentId") or event.get("tool_use_id")
               or resp.get("task_id") or resp.get("id")
               or event.get("task_id") or tool_input.get("task_id"))
    return {"subagent_type": subagent_type, "task_id": task_id}


def append_spawn(spawn, path=LEDGER):
    """Append one spawn as a JSON line. Append-only (no read-merge), so concurrent PostToolUse
    processes for parallel lanes cannot lose each other's writes. Best-effort; creates the dir."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(spawn) + "\n")


def main():
    spawn = spawn_from_event(read_event())
    if spawn is not None:
        try:
            append_spawn(spawn)
        except OSError:
            pass  # recording is best-effort; never break a tool-use
    sys.exit(0)


if __name__ == "__main__":
    main()
