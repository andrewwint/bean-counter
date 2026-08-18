#!/usr/bin/env python3
"""PostToolUse sidecar: record the sensitive seams a REAL triage lane returned, to a session-scoped
ledger the disposition completeness gate trusts at run time.

Wire as a Claude Code PostToolUse hook alongside the spawn sidecar and the Stop hook (settings.json):

  {"hooks": {"PostToolUse": [{"matcher": "Task|Agent",
      "hooks": [{"type": "command",
                 "command": "python3 .claude/skills/baton/hooks/record_triaged_seams.py"}]}]}}

The matcher MUST cover both tool names (`Task|Agent`) for the same reason the spawn sidecar does — a
`Task`-only matcher never fires for `Agent`-named spawns, leaving the ledger empty; under the
completeness gate an empty ledger reads as "no sensitive seam was triaged" and the gate goes silent.

WHY THIS EXISTS. The MISSING-RECORD root cause (smoke zt-120): baton clears a sensitive seam through a
review lane WITHOUT writing `disposition.json` — so the Stop hook globs nothing, the deriver never runs,
and the skip is INVISIBLE. Removing the skip-incentive (the `REVIEWED-CLEAN` verdict) is the behavioral
half; the durable structural half is making the record's *existence* a precondition the manager cannot
silently skip. That needs an INDEPENDENT, forge-proof artifact of what SHOULD have reached a disposition
— which is this ledger. It mirrors the spawn sidecar exactly: a signal the model cannot forge by
NARRATING, because only an actual `Task`/`Agent` tool-use fires the hook.

WHAT IT RECORDS. When a triage lane returns, its final message carries a machine-readable contract line
(the triage return-format contract, SKILL.md / agents/triage.md):

    TRIAGE-SEAMS: <class>@<hint> | <class>@<hint> | ...
    TRIAGE-SEAMS: none

Each `<class>` is drawn from the sensitive taxonomy (tenant-isolation / data-egress / authz /
writes-mutations / auth-gate / secrets / injection-sink); `<hint>` is a free-text locator (optional).
This hook parses that ONE line out of the lane's returned text, filters to the sensitive classes, and
appends each seam to `.agents/runs/triaged_seams.jsonl`. The Stop-hook completeness gate then asserts
every sensitive CLASS triage named reaches a covering `disposition.json`; a triaged sensitive class with
no covering record derives the `MISSING-RECORD` completeness terminal (non-READY), so the skip is now a
present, contract-valid, scorer-readable artifact instead of silence.

We parse the line from ANY `Task`/`Agent` return, not only `subagent_type == "triage"`: the contract is
the LINE, not the lane name, so an inline-via-`general-purpose` triage or a haiku triage lane both work
as long as the line is emitted. `TRIAGE-SEAMS: none` records nothing (an honest empty triage), which is
distinct from the hook never firing — see the completeness gate's sidecar-wired guard.

FAIL-LOUD on a MALFORMED line (Condition 1, ratified). A TRIAGE-SEAMS line whose tokens do not match the
seam grammar is NOT silently dropped — a silent drop would shrink what is owed a disposition and let a real
sensitive seam go uncovered without tripping the gate (fail-permissive, unratifiable). Instead a malformed
line ledgers a `{malformed: true}` marker, and the completeness gate derives UNVERIFIED-SEAM ("triage
output malformed, seams indeterminate"), forcing human attention. Neither silent-drop nor phantom-seam:
loud.

TRUST BOUNDARY, STATED HONESTLY. This proves a triage lane RETURNED a sensitive-seam list, not that the
list is complete or correct — a triage that WELL-FORMEDLY under-reports (names fewer seams than exist, all
grammatical) under-reports the obligation, exactly as the spawn sidecar proves a lane spawned but not that
it did good work. (A MALFORMED line is caught and fails loud per above; the residual is an
honest-but-incomplete well-formed list.) The gate is class-presence, not per-seam identity (a haiku hint
and the record's seam label do not reconcile reliably), so a second seam of an already-covered class is not
separately enforced. Depth stays with the post-hoc scorer. Scope is the session's runs root, not a single
runId: in a hermetic eval trial (one run per workspace) session-scope IS run-scope, the same bridging the
spawn sidecar relies on.

Never blocks: this hook only records. Exit 0 always (a recording failure must not break a tool-use); a
corrupt ledger line is skipped by the reader, not fatal.
"""
import json
import os
import re
import sys

# Append-only JSONL (one seam object per line) — same rationale as the spawn ledger: parallel lanes fire
# this hook as separate processes, and a read-merge-replace would lose seams to last-writer-wins.
LEDGER = os.path.join(".agents", "runs", "triaged_seams.jsonl")

# The sensitive taxonomy — kept in lockstep with disposition_gate.SENSITIVE_CLASSES. A class outside this
# set is recorded as non-sensitive context is not: we only ledger seams the completeness gate governs.
SENSITIVE_CLASSES = {"tenant-isolation", "data-egress", "authz", "writes-mutations",
                     "auth-gate", "secrets", "injection-sink"}

# The contract line. Case-insensitive prefix, tolerant of surrounding markdown/whitespace. Captures the
# remainder of the line after the colon; `none`/empty means an honest empty triage.
_SEAMS_LINE = re.compile(r"TRIAGE-SEAMS:\s*(.*)", re.IGNORECASE)
# The seam SEPARATOR is a WHITESPACE-PADDED pipe (` | ` — the documented format), NOT a bare `|`. This is
# deliberate: a hint is unescaped free text, so a bare `|` inside one (a code snippet, a shorthand list)
# must NOT fragment one real seam into a phantom second one — a phantom whose class happens to be sensitive
# would over-fire a false MISSING-RECORD. Requiring surrounding whitespace means a stray in-hint pipe stays
# in the hint; a genuinely malformed no-space multi-seam line (`authz|secrets`) fails toward UNDER-report
# (the token won't match a class, so it is dropped) — the documented safe direction, never over-report.
_SEAM_SEP = re.compile(r"\s+\|\s+")
# One seam token: `<class>` or `<class>@<hint>`. Class is the leading `[a-z-]+` run; hint is the rest.
_SEAM_TOKEN = re.compile(r"^\s*([a-zA-Z-]+)\s*(?:@\s*(.*?))?\s*$")


def read_event():
    """Return the PostToolUse stdin JSON, or {} if none/unparseable."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}


def response_text(event):
    """Best-effort flatten of a Task/Agent tool_response to searchable text. The response shape varies by
    Claude Code build (a bare string, a `{content: ...}` dict, a list of content blocks); we stringify
    whatever is there so the contract line can be found regardless of shape."""
    resp = event.get("tool_response")
    if resp is None:
        return ""
    if isinstance(resp, str):
        return resp
    parts = []

    def walk(v):
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, dict):
            for val in v.values():
                walk(val)
        elif isinstance(v, (list, tuple)):
            for val in v:
                walk(val)

    walk(resp)
    return "\n".join(parts)


def parse_triage_line(text):
    """Parse the TRIAGE-SEAMS line from `text`. The LAST line wins (a lane may restate it). Returns:
        {"present": bool, "seams": [{class, hint}...], "malformed": bool, "raw": str|None}
    - present: a TRIAGE-SEAMS line was found at all.
    - seams: the SENSITIVE seams named (non-sensitive-but-GRAMMATICAL classes are ignored, not malformed).
    - malformed: a token was present that does NOT match the seam grammar (`<class>[@<hint>]`, separated by
      the whitespace-padded pipe). This is the FAIL-LOUD signal (Condition 1): a malformed line means the
      seam list is INDETERMINATE — we must NOT silently drop the unparseable part (that would shrink what is
      owed a disposition and let a real sensitive seam go uncovered). The gate turns malformed -> UNVERIFIED-
      SEAM ("triage output malformed, seams indeterminate"), forcing human attention. A bare `|` inside a
      hint does NOT trip this (the separator is ` | ` with surrounding whitespace); only a genuinely
      ungrammatical token does (e.g. no-space `authz|secrets`, or `secrets — prose` without an `@`).
    - raw: the payload after the colon, for the operator-facing basis line.
    A grammatical non-sensitive class (`cosmetic`, `cosmetic@readme`) is IGNORED, never malformed."""
    matches = _SEAMS_LINE.findall(text or "")
    if not matches:
        return {"present": False, "seams": [], "malformed": False, "raw": None}
    payload = matches[-1].strip()
    if not payload or payload.lower() == "none":
        return {"present": True, "seams": [], "malformed": False, "raw": payload}
    seams, malformed = [], False
    for token in _SEAM_SEP.split(payload):
        tok = token.strip()
        if not tok:
            continue
        m = _SEAM_TOKEN.match(tok)
        if not m:
            malformed = True  # a present-but-ungrammatical token -> fail loud, never silent-drop
            continue
        cls = (m.group(1) or "").strip().lower()
        hint = (m.group(2) or "").strip()
        if cls in SENSITIVE_CLASSES:
            seams.append({"class": cls, "hint": hint})
        # a grammatical non-sensitive class is intentionally ignored (not owed a disposition), not malformed
    return {"present": True, "seams": seams, "malformed": malformed, "raw": payload}


def parse_seams(text):
    """Back-compat thin wrapper: just the sensitive seams. Callers needing the malformed/fail-loud signal
    use parse_triage_line()."""
    return parse_triage_line(text)["seams"]


def append_records(records, task_id=None, path=LEDGER):
    """Append each ledger record as a JSON line. Append-only (no read-merge), so concurrent PostToolUse
    processes for parallel lanes cannot lose each other's writes. Best-effort; creates the dir. A record is
    either a seam ({class, hint}) or the malformed marker ({malformed: true, raw: ...})."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        for r in records:
            f.write(json.dumps({**r, "task_id": task_id}) + "\n")


# Retained name for callers/tests that append seams directly.
def append_seams(seams, task_id=None, path=LEDGER):
    append_records(seams, task_id=task_id, path=path)


def main():
    event = read_event()
    if event.get("tool_name") not in ("Task", "Agent"):
        sys.exit(0)
    result = parse_triage_line(response_text(event))
    records = list(result["seams"])
    if result["malformed"]:
        # Condition 1: fail LOUD, do not silent-drop. Ledger a malformed marker the completeness gate turns
        # into UNVERIFIED-SEAM — the seam list is indeterminate, so what is owed a disposition cannot shrink.
        records.append({"malformed": True, "raw": result.get("raw")})
    if records:
        tool_input = event.get("tool_input") or {}
        resp = event.get("tool_response") or {}
        task_id = (resp.get("task_id") if isinstance(resp, dict) else None) or tool_input.get("task_id")
        try:
            append_records(records, task_id=task_id)
        except OSError:
            pass  # recording is best-effort; never break a tool-use
    sys.exit(0)


if __name__ == "__main__":
    main()
