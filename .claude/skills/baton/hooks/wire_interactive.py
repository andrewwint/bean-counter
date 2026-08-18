#!/usr/bin/env python3
"""Self-service interactive wiring — the fixer `baton doctor` points installed-skill users at.

The problem it closes: baton's hooks fire automatically under the TypeScript runtime, but an interactive
`/baton` session (no runtime) only fires hooks a settings.json registers. On a machine where the SKILL was
installed (not the repo cloned), there is no `tools/` and no `tools/install.sh` to run — so doctor's old
"run the installer" pointer was a dangling reference. This script IS the installer for that case: it ships
inside the skill, resolves the hooks' absolute paths from ITS OWN location, and wires them into the
user-global `~/.claude/settings.json` — no checkout required.

What it wires (into ~/.claude/settings.json, ABSOLUTE paths so they resolve from any project's cwd):
    Stop         -> disposition_gate.py, ledger.py
    PostToolUse  -> record_lane_spawn.py, record_triaged_seams.py, ledger.py  (matcher Task|Agent)
It EXCLUDES session_start_guard.py: that hook fail-louds when a per-project doctor marker is absent, which
globally would fire in every unrelated repo. It belongs to the per-project `install.sh --enforce` path.

Idempotent and non-clobbering (delegates to wire_settings.wire, which preserves existing config and adds
each hook only if absent). After wiring it runs `baton doctor` and returns its exit code, so a single
command both wires and confirms GREEN.

Run:  python3 ~/.claude/skills/baton/hooks/wire_interactive.py
"""
import os
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import wire_settings as ws  # noqa: E402  (co-located in the shipped skill)


def main():
    home = os.path.expanduser("~")
    settings = os.path.join(home, ".claude", "settings.json")
    # Wire with base = THIS hooks dir (absolute) so the commands resolve regardless of session cwd; the
    # hooks' own write paths stay relative, so the trail lands in whatever project is active.
    rc = ws.wire(home, "baton", base=HOOKS_DIR, exclude={"session_start_guard.py"})
    if rc != 0:
        print(f"error: could not wire {settings} — see above.", file=sys.stderr)
        return rc
    print(f"Wired baton's interactive hooks into {settings} (absolute paths; ledger + enforcement).")
    print("Verifying (baton doctor) ...")
    # Return doctor's verdict as our exit code: 0 == GREEN. Best-effort — a doctor invocation failure
    # must not mask the fact that wiring itself succeeded, so a spawn error still reports the wiring win.
    try:
        return subprocess.call([sys.executable, os.path.join(HOOKS_DIR, "doctor.py"), "--target", home])
    except OSError as e:
        print(f"note: wiring succeeded, but could not run doctor to confirm ({e}); "
              f"run: python3 {os.path.join(HOOKS_DIR, 'doctor.py')} --target {home}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
