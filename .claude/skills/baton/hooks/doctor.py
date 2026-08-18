#!/usr/bin/env python3
"""baton doctor — oracle-free install-health probe (rebrand task §4).

Proves ENFORCEMENT IS WIRED AND FIRING on this machine, then writes a verification marker the SessionStart
guard reads. Two independent facts:

  WIRED   — `.claude/settings.json` registers the Stop hook (`disposition_gate.py`) and the PostToolUse
            spawn-ledger hook (`record_lane_spawn.py`), so Claude Code will actually invoke them.
  FIRING  — a probe run drives the real Stop hook end-to-end and a WELL-FORMED disposition IS written
            (registration != firing: a path/permission/version error can leave a registered hook that
            never writes). Well-formedness is asserted by the VENDORED disposition-contract checker
            (`disposition_contract.check`), the same predicate the eval harness pins — SHAPE only.

BOUNDARY RULE — doctor is ORACLE-FREE. It observes THAT a well-formed disposition is emitted and the gate
fires; it MUST NEVER embed a case with a known-correct verdict to grade right/wrong. The instant it needs
to know the right answer it has become the harness (which HAS an oracle; doctor MUST NOT). So the probe
asserts the record is well-formed and was stamped (`_stamped`), never that the verdict has a particular
value.

RUNTIME-ABSENT FLOOR — the probe invokes the Stop hook via the absolute Python interpreter with `node`
stripped from PATH, so a green proves the enforcement path fires with the optional TypeScript runtime
absent (the Python hook is the standalone floor).

SCOPE OF GREEN — doctor green means enforcement is LIVE on this machine. It is NOT evidence for any
catch-rate or efficacy claim (that stays on the breadth clock, "designed to"). The green string carries
its own scope; a bare "passed" is never printed.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import disposition_contract as contract  # noqa: E402  (vendored, byte-identical, no import edge to the harness)

GATE = os.path.join(HOOKS_DIR, "disposition_gate.py")
# The shipped self-installer doctor points users at — resolved from THIS file's location, so the pointer
# is valid whether the skill was installed to ~/.claude/skills/baton or cloned as the repo (never dangling).
WIRE_INTERACTIVE = os.path.join(HOOKS_DIR, "wire_interactive.py")

# A single sensitive seam so the deriver GOVERNS the run and stamps a verdict. contract_source "none" +
# no review lane is the simplest record that reaches a stamp; the verdict VALUE is irrelevant to doctor
# (oracle-free) — only that a well-formed, stamped disposition is written.
PROBE_RECORD = {
    "run_id": "baton-doctor-probe",
    "seams_triaged": [{"class": "tenant-isolation", "contract_source": "none"}],
    "exposures": [],
    "verdict": "READY",
}


def _node_free_path():
    """PATH with every dir that contains a `node` executable removed — so `node` is unresolvable during
    the probe and a green genuinely proves enforcement fires with the TS runtime absent."""
    parts = [
        d for d in os.environ.get("PATH", "").split(os.pathsep)
        if d and not (os.path.exists(os.path.join(d, "node")) or os.path.exists(os.path.join(d, "node.exe")))
    ]
    return os.pathsep.join(parts)


def run_probe():
    """Drive the real Stop hook end-to-end in an isolated temp CWD with node stripped from PATH.
    Returns (ok: bool, detail: str, runtime_absent: bool)."""
    node_free = _node_free_path()
    runtime_absent = shutil.which("node", path=node_free) is None
    with tempfile.TemporaryDirectory(prefix="baton-doctor-") as ws:
        run_dir = os.path.join(ws, ".agents", "runs", "probe")
        os.makedirs(run_dir)
        disp = os.path.join(run_dir, "disposition.json")
        with open(disp, "w") as f:
            json.dump(PROBE_RECORD, f)
        hook_input = json.dumps({"cwd": ws, "transcript_path": ""})
        try:
            proc = subprocess.run(
                [sys.executable, GATE], cwd=ws, env=dict(os.environ, PATH=node_free),
                input=hook_input, text=True, capture_output=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as e:
            return False, f"could not invoke the Stop hook: {e}", runtime_absent
        if not os.path.isfile(disp):
            return False, f"probe disposition vanished (hook exit {proc.returncode}: {proc.stderr.strip()})", runtime_absent
        try:
            rec = json.loads(open(disp).read())
        except (OSError, ValueError) as e:
            return False, f"probe disposition unreadable after the hook ran: {e}", runtime_absent
        if not rec.get("_stamped"):
            return False, f"Stop hook did not stamp the probe record (exit {proc.returncode}: {proc.stderr.strip()})", runtime_absent
        ok, reason = contract.check(rec)
        if not ok:
            return False, f"the stamped disposition is not well-formed per the contract: {reason}", runtime_absent
        return True, "the Stop hook wrote a well-formed disposition", runtime_absent


def settings_wiring(settings_path, target):
    """(stop_wired, sidecar_wired, triage_wired, settings_sha|None) read from a settings.json. A hook counts
    as WIRED only when settings both NAMES its script AND that script FILE resolves to an existing path — a
    command that points at a missing/typo path is registration without firing, exactly what doctor must catch.
    `triage_wired` is the completeness-gate sidecar (`record_triaged_seams.py`): unwired, the completeness
    gate cannot tell an empty ledger from an uninstalled hook and stays silent, so the MISSING-RECORD skip
    goes undetected — a silent enforcement gap doctor must surface, exactly as it does the spawn sidecar."""
    try:
        raw = open(settings_path, "rb").read()  # RAW bytes — must match the guard's _sha so a byte-identical
    except OSError:                              # settings.json yields the same digest (no CRLF/BOM drift).
        return False, False, False, None
    sha = hashlib.sha256(raw).hexdigest()
    try:
        cfg = json.loads(raw)
    except ValueError:
        return False, False, False, sha
    hooks = cfg.get("hooks", {}) if isinstance(cfg, dict) else {}

    def wired(event, needle):
        for grp in hooks.get(event, []) or []:
            if not isinstance(grp, dict):
                continue
            for h in grp.get("hooks", []) or []:
                if not isinstance(h, dict):
                    continue
                # a command whose script basename == needle, resolving to an existing file (basename, not a
                # bare substring, so `my_disposition_gate.py` does not false-match)
                for tok in str(h.get("command", "")).split():
                    if os.path.basename(tok) == needle:
                        p = tok if os.path.isabs(tok) else os.path.join(target, tok)
                        if os.path.isfile(p):
                            return True
        return False

    return (wired("Stop", "disposition_gate.py"),
            wired("PostToolUse", "record_lane_spawn.py"),
            wired("PostToolUse", "record_triaged_seams.py"),
            sha)


def ledger_wired(settings_path, target):
    """True iff the run-trail hook (ledger.py) is wired on BOTH PostToolUse and Stop with resolvable paths.
    NON-GATING: the ledger is operability, not the security contract, so doctor only WARNS when it is
    missing (a lost trail, never a lost gate). Reuses settings_wiring's resolve-the-path discipline via a
    tiny local re-read so the 4-tuple contract other callers depend on stays unchanged."""
    try:
        cfg = json.loads(open(settings_path, "rb").read())
    except (OSError, ValueError):
        return False
    hooks = cfg.get("hooks", {}) if isinstance(cfg, dict) else {}

    def wired(event):
        for grp in hooks.get(event, []) or []:
            if not isinstance(grp, dict):
                continue
            for h in grp.get("hooks", []) or []:
                if not isinstance(h, dict):
                    continue
                for tok in str(h.get("command", "")).split():
                    if os.path.basename(tok) == "ledger.py":
                        p = tok if os.path.isabs(tok) else os.path.join(target, tok)
                        if os.path.isfile(p):
                            return True
        return False

    return wired("PostToolUse") and wired("Stop")


def write_marker(marker_path, settings_sha, runtime_absent):
    os.makedirs(os.path.dirname(marker_path), exist_ok=True)
    marker = {
        "verified": True,
        "verified_at_epoch": int(time.time()),
        "contract_sha": contract.contract_sha(),
        "settings_sha": settings_sha,  # the guard treats a marker whose settings_sha != current as STALE
        "runtime_absent_proven": runtime_absent,
        "probe": "stop-hook-writes-wellformed-disposition",
    }
    tmp = marker_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(marker, f, indent=2)
    os.replace(tmp, marker_path)


def doctor(target):
    """Run the full check against `target` (a dir holding .claude/settings.json and receiving the marker).
    Returns (green: bool, lines: list[str])."""
    settings_path = os.path.join(target, ".claude", "settings.json")
    marker_path = os.path.join(target, ".baton", "doctor-verified.json")
    stop_wired, sidecar_wired, triage_wired, settings_sha = settings_wiring(settings_path, target)
    probe_ok, probe_detail, runtime_absent = run_probe()
    ledger_ok = ledger_wired(settings_path, target)

    def ledger_warn(lines):
        # NON-GATING operability warning — the run-trail hook is not part of the security contract, so a
        # missing ledger never flips doctor red; it only tells the user the trail won't be hook-maintained.
        if not ledger_ok:
            lines.append("  ⚠ operability: the run-trail hook (ledger.py) is not wired on both PostToolUse "
                         "and Stop here — the .agents/runs/ledger.md trail will not be hook-maintained on the "
                         f"interactive path (enforcement is unaffected). Wire it with: python3 {WIRE_INTERACTIVE}")

    lines = []
    # INTENTIONAL DECOUPLING — do NOT add `ledger_ok` to this condition. The green condition is the SECURITY
    # contract only: the disposition gate (Stop) + the two forge-proof PostToolUse sidecars + an observed
    # firing. The run-trail hook (ledger.py) is OPERABILITY — its absence loses a convenience trail, never a
    # gate — so it must stay a non-gating WARN. Folding it in here would dilute what "doctor-green" means
    # (it would then also assert a trail feature, not just that enforcement fires) and would re-couple the
    # installer to doctor for a non-security hook. Keep the ledger a warning; keep green about the gate.
    if stop_wired and sidecar_wired and triage_wired and probe_ok:
        try:
            write_marker(marker_path, settings_sha, runtime_absent)
        except OSError as e:
            return False, [f"✗ baton doctor: enforcement fires, but the verification marker could not be "
                           f"written ({e}); the SessionStart guard will report unverified. Fix {marker_path} and re-run."]
        lines.append("✓ Enforcement is wired and firing on this machine")
        lines.append(f"  • wired:   Stop + PostToolUse (spawn + triage-seam) hooks registered in {settings_path}")
        lines.append(f"  • firing:  {probe_detail}")
        lines.append(f"  • floor:   fires with the TypeScript runtime absent "
                     f"({'node unresolvable during the probe' if runtime_absent else 'node present, but the probe never invokes it'})")
        lines.append(f"  • marker:  {marker_path}")
        lines.append("  (Scope: proves the enforcement GATE is wired and firing here — that an independent")
        lines.append("   specialist review, when consulted, is recorded and the verdict is gated on it. NOT a")
        lines.append("   catch-rate/efficacy claim, and NOT a claim that any review was security-competent")
        lines.append("   (competence lives in routing, not the gate).)")
        ledger_warn(lines)
        return True, lines

    lines.append("✗ baton doctor: enforcement is NOT verified on this machine")
    if not stop_wired:
        lines.append(f"  ✗ Stop hook (disposition_gate.py) not registered in {settings_path}")
    if not sidecar_wired:
        lines.append(f"  ✗ PostToolUse hook (record_lane_spawn.py) not registered in {settings_path}")
    if not triage_wired:
        lines.append(f"  ✗ PostToolUse hook (record_triaged_seams.py) not registered in {settings_path} "
                     "— the completeness gate is silent without it")
    if not probe_ok:
        lines.append(f"  ✗ probe did not fire cleanly: {probe_detail}")
    ledger_warn(lines)
    lines.append(f"  Fix (installed skill — no checkout needed): python3 {WIRE_INTERACTIVE}")
    lines.append("       (wires the user-global ~/.claude/settings.json with absolute paths, then re-runs "
                 "this check). From a repo clone you can instead run: tools/install.sh --global")
    return False, lines


def main(argv):
    target = os.getcwd()
    if "--target" in argv:
        i = argv.index("--target")
        if i + 1 >= len(argv):
            print("error: --target requires a directory argument", file=sys.stderr)
            sys.exit(2)
        target = argv[i + 1]
    green, lines = doctor(target)
    out = sys.stdout if green else sys.stderr
    for ln in lines:
        print(ln, file=out)
    sys.exit(0 if green else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
