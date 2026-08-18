#!/usr/bin/env python3
"""Self-test for record_seam.py — the manager's inline-seam recorder that arms the completeness gate.

Verifies the recorded seam lands in the SAME ledger the gate reads (round-trips through
disposition_gate.recorded_triaged_seams), that malformed input fails loud, and that a non-sensitive token
records nothing. Run: python3 record_seam_test.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import record_seam as rs  # noqa: E402
import record_triaged_seams as rts  # noqa: E402
import disposition_gate as gate  # noqa: E402

failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


print("A. an inline-recorded seam arms the gate (round-trips through the completeness reader)")
with tempfile.TemporaryDirectory() as t:
    os.chdir(t)
    rc = rs.main(["injection-sink@universe-eval"])
    check("rc 0", rc, 0)
    # The gate reads triaged_seams.jsonl via recorded_triaged_seams — the seam must be visible there.
    seams = gate.recorded_triaged_seams(rts.LEDGER)
    check("gate sees the recorded sensitive class", [s["class"] for s in seams], ["injection-sink"])
    check("hint preserved", seams[0]["hint"], "universe-eval")

print("B. multiple seams via the TRIAGE-SEAMS grammar (space-padded pipe)")
with tempfile.TemporaryDirectory() as t:
    os.chdir(t)
    rs.main(["data-egress@s3-bucket | secrets@iam-role | authz@admin-route"])
    seams = sorted(s["class"] for s in gate.recorded_triaged_seams(rts.LEDGER))
    check("all three sensitive classes recorded", seams, ["authz", "data-egress", "secrets"])

print("C. malformed token fails loud — a MALFORMED marker the gate turns into UNVERIFIED-SEAM")
with tempfile.TemporaryDirectory() as t:
    os.chdir(t)
    rs.main(["authz|secrets"])  # no-space pipe -> ungrammatical single token
    check("malformed marker written (gate -> UNVERIFIED-SEAM)", gate.triage_malformed(rts.LEDGER), True)

print("D. a non-sensitive/empty token records nothing (owes no disposition)")
with tempfile.TemporaryDirectory() as t:
    os.chdir(t)
    rc = rs.main(["cosmetic@readme"])
    check("rc 0", rc, 0)
    check("nothing written -> gate unchanged", gate.recorded_triaged_seams(rts.LEDGER), [])
with tempfile.TemporaryDirectory() as t:
    os.chdir(t)
    check("no args -> usage error rc 2", rs.main([]), 2)

if failures:
    print(f"\nRECORD_SEAM SELFTEST FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
