#!/usr/bin/env python3
"""Self-test for baton doctor (§4). Exercises the probe, the wiring detector (incl. the missing-path
gap), and the green/red end-to-end against constructed temp targets. Oracle-free: never asserts a verdict
value, only that a well-formed disposition is written and that wiring is truthfully detected.

Run: python3 doctor_test.py
"""
import json
import os
import sys
import tempfile

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import doctor  # noqa: E402

GATE = os.path.join(HOOKS_DIR, "disposition_gate.py")
SIDECAR = os.path.join(HOOKS_DIR, "record_lane_spawn.py")
TRIAGE = os.path.join(HOOKS_DIR, "record_triaged_seams.py")
LEDGER = os.path.join(HOOKS_DIR, "ledger.py")
failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


def write_settings(target, stop_cmd, sidecar_cmd, triage_cmd="__default__", ledger=False):
    # triage_cmd defaults to the real triage sidecar so existing green cases stay green; pass None to omit it.
    if triage_cmd == "__default__":
        triage_cmd = f"python3 {TRIAGE}"
    os.makedirs(os.path.join(target, ".claude"), exist_ok=True)
    cfg = {"hooks": {}}
    stop = []
    if stop_cmd is not None:
        stop.append({"type": "command", "command": stop_cmd})
    post = []
    if sidecar_cmd is not None:
        post.append({"type": "command", "command": sidecar_cmd})
    if triage_cmd is not None:
        post.append({"type": "command", "command": triage_cmd})
    if ledger:  # wire ledger.py on BOTH events, as the installer does
        post.append({"type": "command", "command": f"python3 {LEDGER}"})
        stop.append({"type": "command", "command": f"python3 {LEDGER}"})
    if stop:
        cfg["hooks"]["Stop"] = [{"hooks": stop}]
    if post:
        cfg["hooks"]["PostToolUse"] = [{"matcher": "Task|Agent", "hooks": post}]
    with open(os.path.join(target, ".claude", "settings.json"), "w") as f:
        json.dump(cfg, f)


print("A. run_probe — the bundled Stop hook fires end-to-end, runtime-absent")
ok, detail, runtime_absent = doctor.run_probe()
check("probe writes a well-formed, stamped disposition", ok, True)
check("runtime-absent proven (node stripped from probe PATH)", runtime_absent, True)

print("B. settings_wiring — truthful detection incl. the missing-path gap")
with tempfile.TemporaryDirectory() as t:
    check("no settings.json -> not wired", doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)[:2], (False, False))
with tempfile.TemporaryDirectory() as t:
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}")
    sw, pw, tw, _ = doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)
    check("all three hooks named with EXISTING absolute paths -> wired", (sw, pw, tw), (True, True, True))
with tempfile.TemporaryDirectory() as t:
    write_settings(t, "python3 /nope/disposition_gate.py", f"python3 {SIDECAR}")
    sw, pw, tw, _ = doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)
    check("Stop named but path MISSING -> NOT wired (the registration!=firing gap)", sw, False)
    check("sidecar with existing path still wired", pw, True)
with tempfile.TemporaryDirectory() as t:
    # triage sidecar omitted -> completeness gate would be silent; doctor must flag it (not triage_wired)
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}", triage_cmd=None)
    sw, pw, tw, _ = doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)
    check("triage sidecar omitted -> NOT triage_wired (silent completeness gate)", (sw, pw, tw), (True, True, False))
with tempfile.TemporaryDirectory() as t:
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}", triage_cmd="python3 /nope/record_triaged_seams.py")
    _, _, tw, _ = doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)
    check("triage named but path MISSING -> NOT triage_wired", tw, False)
with tempfile.TemporaryDirectory() as t:
    # a sibling script whose basename != disposition_gate.py must NOT count as wired (code-review basename fix)
    sib = os.path.join(t, "my_disposition_gate.py"); open(sib, "w").write("")
    write_settings(t, f"python3 {sib}", f"python3 {SIDECAR}")
    sw, _, _, _ = doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)
    check("sibling my_disposition_gate.py -> NOT counted as Stop wired", sw, False)
with tempfile.TemporaryDirectory() as t:
    os.makedirs(os.path.join(t, ".claude"))
    with open(os.path.join(t, ".claude", "settings.json"), "w") as f:
        f.write("{ not json")
    check("invalid settings JSON -> not wired", doctor.settings_wiring(os.path.join(t, ".claude", "settings.json"), t)[:2], (False, False))

print("C. doctor() end-to-end — green writes marker, red does not")
with tempfile.TemporaryDirectory() as t:
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}")
    green, _ = doctor.doctor(t)
    check("wired + firing -> GREEN", green, True)
    check("green writes the verification marker", os.path.isfile(os.path.join(t, ".baton", "doctor-verified.json")), True)
    if green:
        m = json.loads(open(os.path.join(t, ".baton", "doctor-verified.json")).read())
        check("marker carries the pinned contract_sha", m["contract_sha"], doctor.contract.contract_sha())
        check("marker records the settings_sha (guard uses it for staleness)", bool(m.get("settings_sha")), True)
with tempfile.TemporaryDirectory() as t:
    green, _ = doctor.doctor(t)  # empty target, no settings
    check("unwired -> RED", green, False)
    check("red writes NO marker", os.path.isfile(os.path.join(t, ".baton", "doctor-verified.json")), False)

print("D. ledger warn is NON-GATING — green stays green, warn only when unwired")
sp = lambda t: os.path.join(t, ".claude", "settings.json")  # noqa: E731
with tempfile.TemporaryDirectory() as t:
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}")  # no ledger
    check("ledger not wired -> ledger_wired False", doctor.ledger_wired(sp(t), t), False)
    green, lines = doctor.doctor(t)
    check("missing ledger does NOT flip green red (non-gating)", green, True)
    check("green output carries the ⚠ operability warn", any("ledger.py) is not wired" in l for l in lines), True)
with tempfile.TemporaryDirectory() as t:
    # ledger on Stop ONLY (not PostToolUse) must NOT count as wired — the trail needs both events
    os.makedirs(os.path.join(t, ".claude"))
    with open(os.path.join(t, ".claude", "settings.json"), "w") as f:
        json.dump({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": f"python3 {LEDGER}"}]}]}}, f)
    check("ledger on one event only -> ledger_wired False", doctor.ledger_wired(sp(t), t), False)
with tempfile.TemporaryDirectory() as t:
    write_settings(t, f"python3 {GATE}", f"python3 {SIDECAR}", ledger=True)
    check("ledger wired on both events -> ledger_wired True", doctor.ledger_wired(sp(t), t), True)
    green, lines = doctor.doctor(t)
    check("wired ledger -> GREEN, no warn", green and not any("ledger.py) is not wired" in l for l in lines), True)

if failures:
    print(f"\nDOCTOR SELFTEST FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
