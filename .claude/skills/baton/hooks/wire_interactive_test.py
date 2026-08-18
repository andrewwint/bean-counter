#!/usr/bin/env python3
"""End-to-end for the shipped self-installer (closes the dangling-installer gap): on a machine with ONLY
the installed skill, running `wire_interactive.py` against a fresh user-global settings.json must WIRE the
interactive hooks with absolute paths and leave `baton doctor` GREEN — no manual settings editing.

Drives the REAL wire_interactive.py process with HOME pointed at a temp dir, so it never touches the
developer's real ~/.claude. Run: python3 wire_interactive_test.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WIRE_INTERACTIVE = os.path.join(HERE, "wire_interactive.py")
failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


print("A. fresh HOME -> wire_interactive -> doctor GREEN (the acceptance)")
with tempfile.TemporaryDirectory() as home:
    env = dict(os.environ, HOME=home)  # expanduser('~') resolves to the temp HOME
    # sanity: before wiring, the target has no settings and doctor is RED (so a later green is attributable)
    pre = subprocess.run([sys.executable, os.path.join(HERE, "doctor.py"), "--target", home],
                         capture_output=True, text=True, env=env)
    check("doctor RED before wiring (clean start)", pre.returncode, 1)

    proc = subprocess.run([sys.executable, WIRE_INTERACTIVE], capture_output=True, text=True, env=env)
    check("wire_interactive exit 0 (== doctor GREEN after wiring)", proc.returncode, 0)
    check("output confirms enforcement wired+firing",
          "Enforcement is wired and firing" in proc.stdout, True)

    settings_path = os.path.join(home, ".claude", "settings.json")
    cfg = json.loads(open(settings_path).read())
    hooks = cfg.get("hooks", {})

    def wired(event, script):
        for grp in hooks.get(event, []) or []:
            for h in grp.get("hooks", []) or []:
                for tok in str(h.get("command", "")).split():
                    if os.path.basename(tok) == script and os.path.isabs(tok):
                        return True
        return False

    check("Stop disposition_gate.py wired (absolute)", wired("Stop", "disposition_gate.py"), True)
    check("PostToolUse record_lane_spawn.py wired", wired("PostToolUse", "record_lane_spawn.py"), True)
    check("PostToolUse record_triaged_seams.py wired", wired("PostToolUse", "record_triaged_seams.py"), True)
    check("ledger.py wired on BOTH events",
          wired("PostToolUse", "ledger.py") and wired("Stop", "ledger.py"), True)
    check("session_start_guard.py EXCLUDED (would fail-loud in unrelated repos)",
          any("session_start_guard.py" in str(h.get("command", ""))
              for e in hooks.values() for g in e for h in g.get("hooks", [])), False)

print("B. idempotent — a second run wires nothing new and stays GREEN")
with tempfile.TemporaryDirectory() as home:
    env = dict(os.environ, HOME=home)
    subprocess.run([sys.executable, WIRE_INTERACTIVE], capture_output=True, text=True, env=env)
    n1 = len(json.loads(open(os.path.join(home, ".claude", "settings.json")).read())["hooks"]["Stop"])
    proc2 = subprocess.run([sys.executable, WIRE_INTERACTIVE], capture_output=True, text=True, env=env)
    n2 = len(json.loads(open(os.path.join(home, ".claude", "settings.json")).read())["hooks"]["Stop"])
    check("second run still GREEN (rc 0)", proc2.returncode, 0)
    check("second run adds no duplicate Stop group", n1, n2)

print("C. preserves an existing unrelated user config (never clobbers)")
with tempfile.TemporaryDirectory() as home:
    env = dict(os.environ, HOME=home)
    os.makedirs(os.path.join(home, ".claude"))
    with open(os.path.join(home, ".claude", "settings.json"), "w") as f:
        json.dump({"permissions": {"allow": ["Bash(ls:*)"]}, "tui": "fullscreen"}, f)
    subprocess.run([sys.executable, WIRE_INTERACTIVE], capture_output=True, text=True, env=env)
    cfg = json.loads(open(os.path.join(home, ".claude", "settings.json")).read())
    check("preserved permissions", cfg.get("permissions"), {"allow": ["Bash(ls:*)"]})
    check("preserved tui", cfg.get("tui"), "fullscreen")
    check("added hooks alongside", "hooks" in cfg, True)

if failures:
    print(f"\nWIRE_INTERACTIVE SELFTEST FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
