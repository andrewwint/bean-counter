#!/usr/bin/env python3
"""Dual-event run-trail hook: keep `.agents/runs/ledger.md` reliable regardless of model memory.

Wired on TWO events (see settings.json):
  - PostToolUse (Task|Agent): append one lane line per REAL subagent spawn.
  - Stop: append an idempotent closeout — disposition verdicts, the sensitive-seam disposition
    OR the no-seam explanation, and artifact paths — then print the ledger path.

WHY THIS EXISTS. The run-ledger obligation was prose ("preserve a run trail"), and prose
obligations are remembered, not enforced: across a long multi-loop session the model wrote the
FIRST ledger and rode momentum past the other eight. This hook makes the trail a fact of the
tool-use stream, not the model's discipline — the same move baton already made for lane-spawn
(`record_lane_spawn.py`) and triage-seam (`record_triaged_seams.py`) recording. Acceptance: after
N routed loops, N lane lines exist without the model being reminded.

IT IS OPERABILITY, NOT PART OF THE SECURITY-ENFORCEMENT CONTRACT. Its absence loses a convenience
trail; it never weakens the disposition gate, changes a verdict, or disposes a finding. So `doctor`
does NOT gate green on it (unlike `record_triaged_seams.py`, whose absence silences the completeness
gate). The installer wires it and verifies it, but its wiring is not a safety precondition.

The Stop closeout also answers the "silent absence" confusion: when triage named NO sensitive seam,
a reader who goes looking for `disposition.json` finds nothing and cannot tell a correct no-seam run
from a skipped gate. The closeout writes the one-line reason the record is absent, so the silence is
explained rather than ambiguous.

Never blocks: records best-effort, exit 0 ALWAYS (a trail failure must never break a tool-use or a
stop). Session-scoped at `.agents/runs/` (like `lane_spawns.jsonl` / `triaged_seams.jsonl`): a
PostToolUse event cannot be reliably correlated to the model's semantic `<runId>`, and a
session-scoped ledger already answers what the trail is for — which lanes ran and how it closed.
"""
import glob
import hashlib
import json
import os
import re
import sys
from datetime import datetime

RUNS_DIR = os.path.join(".agents", "runs")
LEDGER = os.path.join(RUNS_DIR, "ledger.md")
LANE_SPAWNS_PATH = os.path.join(RUNS_DIR, "lane_spawns.jsonl")
TRIAGED_SEAMS_PATH = os.path.join(RUNS_DIR, "triaged_seams.jsonl")
COMPLETENESS_RUN_DIR = "_completeness"

# Kept in lockstep with the triage taxonomy (agents/triage.md) and disposition_gate.SENSITIVE_CLASSES.
SENSITIVE_CLASSES = {
    "tenant-isolation", "data-egress", "authz", "writes-mutations",
    "auth-gate", "secrets", "injection-sink",
}

CLOSEOUT_SIG_PREFIX = "<!-- baton-closeout sig:"


def read_event():
    """Return the hook's stdin JSON as a dict (hook_event_name, tool_name, tool_input, ...) or {} if none.
    Normalizes to a dict: well-formed JSON that is not an object (null/int/str/list/bool) yields {}, so
    callers can `.get(...)` unconditionally — the exit-0-always guarantee must not depend on stdin shape."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        parsed = json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _now():
    """Wall-clock stamp for the human trail. Isolated so tests can substitute a fixed value."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _ensure_header(path=LEDGER):
    """Create the ledger with a title the first time anything is written, so the file explains itself."""
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(
            "# Baton run ledger\n\n"
            "Hook-maintained trail of this session's lanes and closeouts "
            "(`.claude/skills/baton/hooks/ledger.py`). Session-scoped, best-effort, never authoritative "
            "for a verdict — the disposition record and its Stop-hook derivation are. Local working "
            "state; commit it only if you want the trail in history (see SKILL.md → Run Artifacts).\n\n"
        )


def append_line(text, path=LEDGER):
    """Append one line to the ledger. Append-only (single `open(a)` write), so concurrent PostToolUse
    processes for parallel lanes cannot lose each other's writes — the same race-safety the JSONL
    sidecars rely on. Best-effort; creates the dir/header. Never raises to the caller."""
    try:
        _ensure_header(path)
        with open(path, "a") as f:
            f.write(text.rstrip("\n") + "\n")
    except OSError:
        pass  # a trail write must never break the tool-use


# ---- PostToolUse: one lane line per real spawn -------------------------------------------------

def lane_from_event(event):
    """{subagent_type, task_id} for a Task/Agent spawn, or None for anything else. Mirrors
    record_lane_spawn.spawn_from_event so the human trail and the machine ledger see the same spawns."""
    if event.get("tool_name") not in ("Task", "Agent"):
        return None
    tool_input = event.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}  # a truthy non-dict must not crash .get
    subagent_type = tool_input.get("subagent_type")
    if not subagent_type:
        return None
    resp = event.get("tool_response")
    resp = resp if isinstance(resp, dict) else {}
    # Stable spawn id (probed from real payloads): `tool_response.agentId`, else top-level `tool_use_id`.
    # Kept in lockstep with record_lane_spawn.spawn_from_event. Used for the trail suffix AND for the
    # de-dup below (two double-fired firings of one spawn carry the SAME id).
    task_id = (resp.get("agentId") or event.get("tool_use_id")
               or resp.get("task_id") or resp.get("id")
               or event.get("task_id") or tool_input.get("task_id"))
    return {"subagent_type": subagent_type, "task_id": task_id}


def _dedup_new(spawn_id, runs_dir=RUNS_DIR):
    """Race-safe first-writer-wins de-dup. Returns True iff this spawn_id has not been recorded before, by
    ATOMICALLY creating a per-id marker with O_CREAT|O_EXCL — so when the hook is wired in more than one
    settings scope (project + user-global) and both processes fire for ONE real spawn, exactly one wins the
    create and writes the lane line; the other gets FileExistsError and skips. No id -> always True (cannot
    de-dup, so prefer an over-count to dropping a real lane). Best-effort: any other fs error -> True."""
    if not spawn_id:
        return True
    seen = os.path.join(runs_dir, "_ledger_seen")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(spawn_id))[:200]
    try:
        os.makedirs(seen, exist_ok=True)
        fd = os.open(os.path.join(seen, safe), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except OSError:
        return True


# The lane-line marker phrase (writer) and the ANCHORED reader pattern (counter) — kept in sync so the
# close-out count is derived from the SAME lines it displays and cannot drift. The reader anchors on the
# FULL shape `- <ts> · lane spawned: ` (leading "- ", the "·" separator, the phrase), NOT a bare
# "lane spawned:" substring: otherwise an interpolated string that happens to contain the phrase (e.g. a
# disposition verdict written into a close-out line) would be miscounted as a lane. No line the ledger
# writes other than a real lane line matches this anchored shape.
_LANE_MARK = "lane spawned:"
_LANE_LINE_RE = re.compile(r"^- .+ · lane spawned: ")


def lane_line(lane, ts):
    tid = f" · task `{lane['task_id']}`" if lane.get("task_id") else ""
    return f"- {ts} · {_LANE_MARK} `{lane['subagent_type']}`{tid}"


# ---- Stop: idempotent closeout ------------------------------------------------------------------

def sensitive_triaged(path=TRIAGED_SEAMS_PATH):
    """The distinct sensitive seam CLASSES a real triage lane recorded (from the forge-proof sidecar).
    Absent/corrupt ledger -> []. Filters to the sensitive taxonomy defensively."""
    classes = []
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return classes
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            s = json.loads(line)
        except ValueError:
            continue
        cls = s.get("class")
        if cls in SENSITIVE_CLASSES and cls not in classes:
            classes.append(cls)
    return classes


def lane_count(ledger_path=LEDGER):
    """Lanes recorded this session, for the close-out — counted from ledger.py's OWN lane lines and ONLY
    those, so the number ALWAYS equals the lines shown directly above it (they are literally those lines).

    This is the SINGLE-SOURCE fix, superseding 1.3.1's `max(own, sibling)` reconciliation. That earlier
    version cured "count below lines" but a real session then exposed the inverse: it printed "recorded: 23"
    over just 4 visible lane lines (ledger.py was wired mid-session and missed early spawns the sibling
    `lane_spawns.jsonl` had caught). Reconciling two observers of one fact meant the number could disagree
    with the trail in EITHER direction. The trail's count must describe the trail: count its own lines, and
    the two can never contradict. The forge-proof sibling ledger keeps its own job (the disposition deriver);
    it is not this human count's source. A fresh session wires ledger.py from the start, so its own lines
    are the complete set anyway."""
    try:
        return sum(1 for line in open(ledger_path).read().splitlines() if _LANE_LINE_RE.match(line))
    except OSError:
        return 0


def collect_verdicts(runs_dir=RUNS_DIR):
    """[(run_id, verdict)] read from every `.agents/runs/*/disposition.json`. `_completeness` sentinels are
    included — a MISSING-RECORD / UNVERIFIED-SEAM there is exactly what a reader needs.

    ORDER IS NOT GUARANTEED. Claude Code runs all Stop hooks for an event IN PARALLEL (settings.json order
    is cosmetic), so disposition_gate.py may not have stamped the record yet when this reads it. That is
    tolerated: an unstamped record reads as the model's advisory `verdict` or `"unstamped"`, never a crash
    (the read is atomic — disposition_gate stamps via temp+os.replace — and a mid-write/corrupt read is
    caught below as "unreadable-record"). The trail SELF-CORRECTS: once the gate stamps, the derived verdict
    differs from what was recorded, the closeout signature changes, and the next Stop appends a fresh,
    correct closeout. So the trail is eventually-consistent with the gate, and the gate remains the sole
    authority for the verdict — the ledger never derives or overrides it."""
    out = []
    for path in sorted(glob.glob(os.path.join(runs_dir, "*", "disposition.json"))):
        run_id = os.path.basename(os.path.dirname(path))
        try:
            rec = json.loads(open(path).read())
        except (OSError, ValueError):
            out.append((run_id, "unreadable-record"))
            continue
        out.append((run_id, rec.get("verdict") or "unstamped"))
    return out


def closeout_body(ts, lanes, seams, verdicts):
    """The human-readable closeout block, WITHOUT the signature marker (added by closeout_block).

    NOTE — there is deliberately NO close-out "a seam was named inline but not recorded" WARN. A reliable
    one is not achievable from here: the skill's own content (loaded into the session transcript) contains
    the seam examples and the `TRIAGE-SEAMS:` token, and `TRIAGE-SEAMS: none` is the CLEAN-path signal — so
    any transcript scan cries wolf on essentially every no-seam run, training the reader to ignore it.
    Inline seam-naming is also indistinguishable from the manager merely discussing a seam. The inline-seam
    blind spot is closed instead by (a) `hooks/record_seam.py` + the SKILL.md rule that a named seam MUST be
    machine-recorded, and (b) the authoritative post-hoc scorer against the full stream — not by a
    best-effort close-out signal that can't tell a real inline seam from the skill's own example text."""
    # "so far", not "this session": Stop fires on every turn end, so a session accrues MULTIPLE close-outs,
    # each a running snapshot (0 lanes at the first stop, 1 after a lane spawns, ...). "so far" tells a
    # reader the number is cumulative-at-this-stop, not a final "the session had N lanes" — the ambiguity a
    # 0-then-1 sequence otherwise creates.
    lines = [f"## closeout — {ts}", f"- lanes recorded so far: {lanes}"]
    if seams:
        lines.append(f"- sensitive seams triaged: {', '.join(seams)}")
        covered = {run for run, _ in verdicts}
        if verdicts:
            lines.append("- disposition verdicts: "
                         + "; ".join(f"`{r}` → {v}" for r, v in verdicts))
        # The completeness gate (disposition_gate.py) is the authority on whether every seam is covered;
        # this line only points the reader at where to confirm, it does not re-derive coverage.
        if COMPLETENESS_RUN_DIR not in covered:
            lines.append(f"- note: no `{COMPLETENESS_RUN_DIR}` sentinel present — the completeness gate "
                         "found every triaged seam covered, or the triage sidecar is unwired")
    else:
        # The "silent absence" fix: explain WHY there is no disposition.json so a reader does not
        # mistake a correct no-seam run for a skipped gate.
        lines.append("- no sensitive seams triaged → READY by the no-seam row of the disposition "
                     "table; **no `disposition.json` is required** — its absence is expected here, "
                     "not a skipped gate")
        if verdicts:
            lines.append("- disposition verdicts: "
                         + "; ".join(f"`{r}` → {v}" for r, v in verdicts))
    lines.append(f"- trail: `{LEDGER}`")
    return "\n".join(lines)


def _signature(lanes, seams, verdicts):
    """A content hash over the closeout's MEANINGFUL state (not the timestamp), so a repeated Stop with
    no new work does not append a duplicate block, but a genuinely advanced session does."""
    basis = json.dumps({"lanes": lanes, "seams": sorted(seams),
                        "verdicts": sorted(verdicts)}, sort_keys=True)
    return hashlib.sha256(basis.encode()).hexdigest()[:12]


def last_signature(path=LEDGER):
    """The signature of the most recent closeout already in the ledger, or None. Lets Stop skip a
    no-change re-append. Reads the whole (small, session-scoped) file — simplest correct approach."""
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        line = line.strip()
        if line.startswith(CLOSEOUT_SIG_PREFIX):
            return line[len(CLOSEOUT_SIG_PREFIX):].rstrip(" -->").strip()
    return None


def closeout_block(ts, lanes, seams, verdicts):
    sig = _signature(lanes, seams, verdicts)
    return closeout_body(ts, lanes, seams, verdicts) + f"\n{CLOSEOUT_SIG_PREFIX}{sig} -->\n", sig


def handle_stop(path=LEDGER, ts=None):
    """Append a closeout iff state advanced since the last one. Returns the ledger path (for the caller
    to surface), or None if nothing was appended."""
    ts = ts or _now()
    lanes = lane_count()
    seams = sensitive_triaged()
    verdicts = collect_verdicts()
    block, sig = closeout_block(ts, lanes, seams, verdicts)
    if last_signature(path) == sig:
        return path  # nothing changed since the last closeout; do not spam duplicates
    try:
        _ensure_header(path)
        with open(path, "a") as f:
            f.write("\n" + block)
    except OSError:
        return None
    return path


def _run():
    event = read_event()
    hook = event.get("hook_event_name")
    if hook == "Stop":
        path = handle_stop()
        if path:
            # Surface the trail path. Write to STDERR, not stdout: Claude Code may try to parse a Stop
            # hook's stdout as a JSON decision object, and non-JSON there triggers a "JSON validation
            # failed" notice. stderr on exit 0 is shown in the transcript/debug without being parsed.
            # (The user-visible surfacing is the manager printing the path at close-out, per SKILL.md.)
            print(f"baton: run trail at {path}", file=sys.stderr)
    else:  # PostToolUse (the wired matcher guarantees Task|Agent), or any non-Stop invocation
        lane = lane_from_event(event)
        if lane is not None and _dedup_new(lane.get("task_id")):
            append_line(lane_line(lane, _now()))


def main():
    # Exit 0 ALWAYS: a trail hook must never break a tool-use or a stop. read_event/append_line/handle_stop
    # are each defensive, but this outer guard makes the guarantee total against any unforeseen input.
    try:
        _run()
    except Exception:  # noqa: BLE001 — deliberate: no ledger failure may propagate to the session
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
