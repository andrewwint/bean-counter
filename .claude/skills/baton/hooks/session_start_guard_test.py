#!/usr/bin/env python3
"""Self-test for the baton SessionStart fail-loud guard (§6). Covers the marker states (absent, current,
stale-by-settings, stale-by-contract, unverified) via evaluate(), plus the real exit-code + channels via
subprocess.

Run: python3 session_start_guard_test.py
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import session_start_guard as guard  # noqa: E402

GUARD = os.path.join(HOOKS_DIR, "session_start_guard.py")
failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


def setup(target, marker=None, settings=b'{"hooks":{}}'):
    """Write .claude/settings.json (so settings_sha is computable) and optionally a marker."""
    os.makedirs(os.path.join(target, ".claude"), exist_ok=True)
    if settings is not None:
        with open(os.path.join(target, ".claude", "settings.json"), "wb") as f:
            f.write(settings)
    if marker is not None:
        os.makedirs(os.path.join(target, ".baton"), exist_ok=True)
        with open(os.path.join(target, ".baton", "doctor-verified.json"), "w") as f:
            json.dump(marker, f)


def settings_sha(settings=b'{"hooks":{}}'):
    return hashlib.sha256(settings).hexdigest()


def good_marker(settings=b'{"hooks":{}}'):
    return {"verified": True, "settings_sha": settings_sha(settings), "contract_sha": guard._CURRENT_CONTRACT_SHA}


print("A. evaluate() — marker states")
with tempfile.TemporaryDirectory() as t:
    setup(t)  # no marker
    check("no marker -> not ok", guard.evaluate(t)[0], False)
with tempfile.TemporaryDirectory() as t:
    setup(t, marker=good_marker())
    check("current marker (settings + contract match) -> ok", guard.evaluate(t)[0], True)
with tempfile.TemporaryDirectory() as t:
    setup(t, marker=good_marker(), settings=b'{"hooks":{"Stop":[]}}')  # settings CHANGED after marker
    check("settings changed since verify -> STALE (not ok)", guard.evaluate(t)[0], False)
with tempfile.TemporaryDirectory() as t:
    m = good_marker()
    m["contract_sha"] = "deadbeef" * 8  # contract changed
    setup(t, marker=m)
    check("contract changed since verify -> STALE (not ok)", guard.evaluate(t)[0], False)
with tempfile.TemporaryDirectory() as t:
    m = good_marker()
    m["verified"] = False
    setup(t, marker=m)
    check("marker verified:false -> not ok", guard.evaluate(t)[0], False)
with tempfile.TemporaryDirectory() as t:
    # valid JSON but NOT an object — must not crash the session (code-review C#1)
    setup(t)
    os.makedirs(os.path.join(t, ".baton"))
    open(os.path.join(t, ".baton", "doctor-verified.json"), "w").write("[]")
    ok, _ = guard.evaluate(t)
    check("non-object marker -> not ok (no crash)", ok, False)
with tempfile.TemporaryDirectory() as t:
    # marker good, but the settings.json it was verified against is now GONE — loudest stale (code-review C#2)
    setup(t, marker=good_marker())
    os.remove(os.path.join(t, ".claude", "settings.json"))
    check("settings.json missing after verify -> STALE (not silently ok)", guard.evaluate(t)[0], False)


def run_guard(target):
    p = subprocess.run([sys.executable, GUARD], input=json.dumps({"cwd": target}),
                       text=True, capture_output=True, timeout=15)
    return p.returncode, p.stdout, p.stderr


print("B. real hook — exit codes + channels")
with tempfile.TemporaryDirectory() as t:
    setup(t)  # no marker
    rc, out, err = run_guard(t)
    check("absent marker -> exit 2 (fail-loud)", rc, 2)
    check("fail-loud writes the warning to stderr (exit-2 channel)", "NOT verified" in err, True)
    payload = json.loads(out) if out.strip() else {}
    check("fail-loud emits systemMessage (channel 1)", "Baton enforcement" in payload.get("systemMessage", ""), True)
    check("fail-loud emits additionalContext for the assistant (channel 4)",
          "UNVERIFIED" in payload.get("hookSpecificOutput", {}).get("additionalContext", ""), True)
    check("fail-loud emits a terminal sequence (channel 3)", "\x1b]9;" in payload.get("terminalSequence", ""), True)
with tempfile.TemporaryDirectory() as t:
    setup(t, marker=good_marker())
    rc, out, err = run_guard(t)
    check("current marker -> exit 0 (silent)", rc, 0)
    check("verified -> no stderr noise", err.strip(), "")

if failures:
    print(f"\nGUARD SELFTEST FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
