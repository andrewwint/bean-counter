#!/usr/bin/env python3
"""Atomically wire baton's hooks into a target's .claude/settings.json (rebrand task §3).

Merges the four enforcement hooks — Stop (disposition_gate.py), PostToolUse Task|Agent
(record_lane_spawn.py and record_triaged_seams.py), SessionStart (session_start_guard.py) — plus the
operability run-trail hook (ledger.py, wired on BOTH PostToolUse Task|Agent and Stop) into
<target>/.claude/settings.json, PRESERVING any existing hooks/config and adding each only if not already
present (idempotent). Writes atomically (temp + replace). Exits 0 only when EVERY (event, script) pairing
below is registered after the merge; non-zero otherwise — so a partial wiring never reports success (the
installer must not present an incomplete install as done).

`ledger.py` is operability, not part of the security-enforcement contract: `doctor` does NOT gate green on
it (its absence loses a convenience trail, never weakens the disposition gate). The installer still wires
and verifies it, but because doctor does not require it there is no installer-vs-doctor mismatch (the
failure mode that once shipped: doctor demanding a hook the installer omitted). A single script wired on
two events appears as two rows below and is verified per (event, script).

Usage: wire_settings.py <target-dir> [skill-name]   (skill-name defaults to `baton`)
"""
import json
import os
import sys

# (event, matcher-or-None, script) — the wiring contract. Order is stable for readable diffs.
# record_triaged_seams.py (the completeness-gate triage-seam sidecar, 1.2.0) MUST be wired alongside
# record_lane_spawn.py — doctor requires it (an unwired triage sidecar leaves the completeness gate silent),
# so an installer that omits it produces a red doctor and a failed install. ledger.py (1.2.x) is wired on
# two events; doctor does not require it (operability, not enforcement), but the installer still verifies it.
HOOKS = [
    ("Stop", None, "disposition_gate.py"),
    ("PostToolUse", "Task|Agent", "record_lane_spawn.py"),
    ("PostToolUse", "Task|Agent", "record_triaged_seams.py"),
    ("SessionStart", None, "session_start_guard.py"),
    ("PostToolUse", "Task|Agent", "ledger.py"),
    ("Stop", None, "ledger.py"),
]


def _command(skill, script, base=None):
    """The hook command. Default is a RELATIVE path (`.claude/skills/<skill>/hooks/<script>`) — correct for
    a project/enforce install, where the skill is copied into the target and hooks run with cwd=target.
    For the USER-GLOBAL interactive path, cwd is an arbitrary project (not the baton checkout), so the
    relative path would not resolve; pass `base` = the ABSOLUTE hooks dir (e.g. ~/.claude/skills/baton/hooks)
    so the command points at the installed hooks regardless of session cwd. The hooks' own WRITE paths
    (`.agents/runs/...`) stay relative — the trail lands in the active project, which is what we want."""
    # Known residual: the command is unquoted, and both _names_script here and doctor's wiring check match
    # by whitespace-splitting the command, so a `base` with a SPACE (a home dir with a space) would break
    # both the basename match and the launch under `sh -c`. Not handled — quoting would itself break the
    # split-then-basename matching, and a spaced home is rare; documented rather than papered over.
    if base:
        return f"python3 {base.rstrip('/')}/{script}"
    return f"python3 .claude/skills/{skill}/hooks/{script}"


def _names_script(command, script):
    """True iff a hook command invokes exactly `script` — the last path segment of some whitespace token
    equals `script`. Basename match (not a bare substring), so a sibling like `my_disposition_gate.py` or
    `.../foo/disposition_gate.py.bak` does NOT false-match and cause the real hook to be skipped."""
    for tok in str(command).split():
        if os.path.basename(tok) == script:
            return True
    return False


def _already_wired(hooks_cfg, event, script):
    grps = hooks_cfg.get(event, [])
    if not isinstance(grps, list):
        return False  # a non-list event is malformed; treat as "not wired" and let wire() refuse to clobber
    for grp in grps:
        if not isinstance(grp, dict):
            continue
        for h in grp.get("hooks", []) or []:
            if isinstance(h, dict) and _names_script(h.get("command", ""), script):
                return True
    return False


def wire(target, skill, base=None, exclude=()):
    """Merge the wiring contract into <target>/.claude/settings.json. `base` (absolute hooks dir) switches
    the commands to absolute paths for the user-global interactive path. `exclude` is a set of script
    basenames to skip — the global path excludes `session_start_guard.py`, whose per-project doctor-marker
    model would fail-loud in every unrelated repo if wired globally (it belongs to the --enforce path)."""
    hooks = [(e, m, s) for (e, m, s) in HOOKS if s not in exclude]
    settings_path = os.path.join(target, ".claude", "settings.json")
    try:
        os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    except OSError as e:
        print(f"error: cannot create {os.path.dirname(settings_path)}: {e}", file=sys.stderr)
        return 1
    # Distinguish ABSENT (create fresh) from PRESENT-BUT-UNPARSEABLE (abort — never clobber a user's config).
    if os.path.exists(settings_path):
        try:
            cfg = json.loads(open(settings_path).read())
        except (OSError, ValueError) as e:
            print(f"error: {settings_path} exists but is unreadable/invalid JSON ({e}) — refusing to "
                  f"overwrite it; fix or move it, then re-run.", file=sys.stderr)
            return 1
        if not isinstance(cfg, dict):
            print(f"error: {settings_path} is not a JSON object — refusing to clobber", file=sys.stderr)
            return 1
    else:
        cfg = {}
    hooks_cfg = cfg.setdefault("hooks", {})
    if not isinstance(hooks_cfg, dict):
        print(f"error: {settings_path} has a non-object 'hooks' — refusing to clobber", file=sys.stderr)
        return 1

    added, present = [], []
    for event, matcher, script in hooks:
        if _already_wired(hooks_cfg, event, script):
            present.append(f"{event}:{script}")
            continue
        existing = hooks_cfg.setdefault(event, [])
        if not isinstance(existing, list):
            print(f"error: hooks.{event} is not a list — refusing to clobber", file=sys.stderr)
            return 1
        entry = {"hooks": [{"type": "command", "command": _command(skill, script, base)}]}
        if matcher is not None:
            entry["matcher"] = matcher
        existing.append(entry)
        added.append(f"{event}:{script}")

    try:
        tmp = settings_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, settings_path)
    except OSError as e:
        print(f"error: could not write {settings_path}: {e}", file=sys.stderr)
        return 1

    # Verify against the PERSISTED file (re-read from disk, not the in-memory cfg) — a truncated/failed
    # write must be caught here, so "all three registered" is a fact about what actually landed.
    try:
        on_disk = json.loads(open(settings_path).read()).get("hooks", {})
    except (OSError, ValueError) as e:
        print(f"error: settings.json unreadable after write ({e})", file=sys.stderr)
        return 1
    # Verify per (event, script) — a script wired on two events (ledger.py) must be confirmed on each,
    # so this must not collapse to one-event-per-script. Verifies the SAME `hooks` set that was wired
    # (an excluded hook is not expected on disk).
    missing = [f"{event}:{script}" for event, _, script in hooks
               if not _already_wired(on_disk, event, script)]
    for s in added:
        print(f"  wired:   {s}")
    for s in present:
        print(f"  present: {s} (already wired)")
    if missing:
        print(f"error: after merge these hooks are NOT registered on disk: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


def main(argv):
    # Optional flags: --hooks-base <abs-hooks-dir> (absolute commands, for the user-global interactive
    # path) and --exclude <script> (repeatable; skip a hook, e.g. session_start_guard.py globally).
    argv = list(argv)
    base = None
    exclude = []
    i = 0
    rest = []
    while i < len(argv):
        if argv[i] in ("--hooks-base", "--exclude"):
            if i + 1 >= len(argv):  # a value-less flag must ERROR, not silently become a positional
                print(f"error: {argv[i]} requires a value", file=sys.stderr)
                return 2
            if argv[i] == "--hooks-base":
                base = argv[i + 1]
            else:
                exclude.append(argv[i + 1])
            i += 2; continue
        rest.append(argv[i]); i += 1
    if not rest:
        print("usage: wire_settings.py <target-dir> [skill-name] "
              "[--hooks-base <abs-hooks-dir>] [--exclude <script>]...", file=sys.stderr)
        return 2
    target = rest[0]
    skill = rest[1] if len(rest) > 1 else "baton"
    return wire(target, skill, base=base, exclude=set(exclude))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
