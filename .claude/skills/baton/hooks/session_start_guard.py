#!/usr/bin/env python3
"""baton SessionStart fail-loud guard (rebrand task §6).

Reads the `baton doctor` verification marker at session start and, when enforcement is NOT verified
(marker absent) or STALE (the wiring or the contract has changed since it was verified), announces it
LOUDLY so an unverified install cannot silently run in advisory mode. It WARNS; it cannot block session
start (no Claude Code hook can) — "announce, do not silently proceed" is the achievable guarantee.

FAIL-LOUD IS EMITTED ON EVERY AVAILABLE CHANNEL, by design: `systemMessage`, exit-2 stderr, a raw terminal
sequence, and `additionalContext`. Which of these actually renders to the human is CLAUDE-CODE-VERSION
DEPENDENT and, at time of writing, unverified for SessionStart hooks (systemMessage is reported not to
render for session-lifecycle hooks; SessionStart stderr-on-exit-2 display is claimed fixed only in a later
CC build). We do NOT claim any single channel is a guaranteed save — the interactive verification will
establish which channel(s) render at which version. Firing all of them is correct regardless. The
`additionalContext` channel is confirmed to reach the ASSISTANT's context, so at minimum the assistant is
told and can surface it to the user.

MIN_CC_VERSION is intentionally left OPEN (None) — the floor value must be pinned to a VERIFIED build, not
a claimed one; see the rebrand design's open min-version question.
"""
import hashlib
import json
import os
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
try:
    import disposition_contract as contract
    _CURRENT_CONTRACT_SHA = contract.contract_sha()
except Exception:  # the guard must never crash the session; treat an unreadable contract as sha-unknown
    _CURRENT_CONTRACT_SHA = None

# Parameterized-OPEN: the minimum Claude Code version whose SessionStart guard is known (VERIFIED, not
# claimed) to render a user-visible warning. Left None until interactive verification pins it; the guard
# does not gate on a version it cannot honestly stand behind.
MIN_CC_VERSION = None

MARKER_REL = os.path.join(".baton", "doctor-verified.json")
SETTINGS_REL = os.path.join(".claude", "settings.json")


def _read_stdin():
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}


def _sha(path):
    try:
        return hashlib.sha256(open(path, "rb").read()).hexdigest()
    except OSError:
        return None


def evaluate(cwd):
    """Return (ok: bool, reason: str). ok=True only when a current, non-stale marker is present."""
    marker_path = os.path.join(cwd, MARKER_REL)
    try:
        marker = json.loads(open(marker_path).read())
    except (OSError, ValueError):
        return False, "enforcement is not verified on this machine (no baton doctor marker)"
    if not isinstance(marker, dict):  # a valid-JSON-but-non-object marker must not crash the session
        return False, "the baton doctor marker is malformed — re-run baton doctor"
    if not marker.get("verified"):
        return False, "the baton doctor marker does not record a verified run"
    # A recorded settings_sha must still MATCH the current wiring. A missing/unreadable settings.json
    # (cur is None) is the LOUDEST stale case — the wiring the guard exists to protect is gone — not a skip.
    recorded_settings = marker.get("settings_sha")
    if recorded_settings and _sha(os.path.join(cwd, SETTINGS_REL)) != recorded_settings:
        return False, "enforcement wiring (.claude/settings.json) is missing or changed since it was last verified — re-run baton doctor"
    if _CURRENT_CONTRACT_SHA and marker.get("contract_sha") and marker["contract_sha"] != _CURRENT_CONTRACT_SHA:
        return False, "the disposition contract changed since it was last verified — re-run baton doctor"
    return True, "verified"


def fail_loud(reason):
    """Emit the warning on every available channel. No channel is claimed as a guaranteed render."""
    warn = f"⚠️  Baton enforcement NOT verified: {reason}. Run: baton doctor"
    # Channel 1 + 4: stdout JSON — systemMessage (documented) + additionalContext (reaches the assistant).
    payload = {
        "systemMessage": warn,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": (
                "BATON ENFORCEMENT IS UNVERIFIED on this machine — the disposition gate may not be firing. "
                f"Reason: {reason}. Tell the user to run `baton doctor`, and do not rely on enforcement "
                "until it is green."
            ),
        },
        # Channel 3: raw terminal sequence (OSC 9 desktop notification). Best-effort; not a guaranteed save.
        "terminalSequence": f"\x1b]9;{warn}\x07",
    }
    try:
        print(json.dumps(payload))
    except OSError:
        pass
    # Channel 2 + 3: exit-2 stderr, with a raw ANSI-bold + OSC 9 sequence in case stderr reaches the TTY.
    sys.stderr.write(f"\x1b]9;{warn}\x07\x1b[1;33m{warn}\x1b[0m\n")
    sys.exit(2)


def main():
    cwd = _read_stdin().get("cwd") or os.getcwd()
    ok, reason = evaluate(cwd)
    if ok:
        sys.exit(0)  # verified — stay silent
    fail_loud(reason)


if __name__ == "__main__":
    main()
