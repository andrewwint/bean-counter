#!/usr/bin/env python3
"""Conformance test for the VENDORED disposition-contract checker (task 5.1).

Two guarantees:
  1. DRIFT PIN — `contract_sha()` must equal the pinned value that the eval harness also pins. The checker is
     vendored BYTE-IDENTICAL into both repos and neither owns it; if baton's copy is edited without eval's
     mirroring (or vice versa), the sha changes and this test fails loudly in the copy that drifted. This is
     the shared-assertion handshake — same shape as the REVIEWED-CLEAN string — with NO import edge either
     direction (eval stays the independent witness).
  2. KNOWN-GOOD / KNOWN-BAD — the predicate accepts well-formed records and rejects each malformation, over
     the ratified schema (task 5.2): core fields + per-seam `named_exposures`/`review_result` type-checked
     where present, shape-only, never the verdict.

Run: python3 disposition_contract_test.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import disposition_contract as dc  # noqa: E402

# Pinned in BOTH vendored copies. Eval pins the same value (86a18ba); a drift in either copy fails here.
PINNED_CONTRACT_SHA = "e5bc5f6546bd642a23cbc5e9ee39f3d9bef29eab2a4317313b34e52fedea7d11"

failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


def ok(record):
    return dc.check(record)[0]


# ---- Drift pin ----------------------------------------------------------------------------------
print("A. CONTRACT_SHA drift pin")
check("contract_sha() matches the pinned value (byte-identical vendoring)",
      dc.contract_sha(), PINNED_CONTRACT_SHA)

# ---- Known-good ---------------------------------------------------------------------------------
print("B. Known-good — well-formed records accepted")
check("minimal well-formed (empty seams/exposures)",
      ok({"run_id": "r1", "seams_triaged": [], "exposures": [], "verdict": "READY"}), True)
check("sensitive seam + named_exposures list + review_result string",
      ok({"run_id": "r2", "verdict": "IDENTIFIED-UNRESOLVED", "exposures": [],
          "seams_triaged": [{"class": "tenant-isolation", "named_exposures": ["cross-tenant read"],
                             "review_result": "exposure-found"}]}), True)
check("named_exposures as a bare non-empty string (= one finding, ratified schema)",
      ok({"run_id": "r3", "verdict": "IDENTIFIED-UNRESOLVED", "exposures": [],
          "seams_triaged": [{"class": "authz", "named_exposures": "missing gate"}]}), True)
check("seam WITHOUT the optional review-provenance fields (they are optional)",
      ok({"run_id": "r4", "verdict": "READY", "exposures": [],
          "seams_triaged": [{"class": "data-egress"}]}), True)
check("named_exposures explicitly null is fine (optional/absent)",
      ok({"run_id": "r5", "verdict": "READY", "exposures": [],
          "seams_triaged": [{"class": "secrets", "named_exposures": None, "review_result": None}]}), True)

# ---- Known-bad ----------------------------------------------------------------------------------
print("C. Known-bad — each malformation rejected")
check("missing run_id",
      ok({"seams_triaged": [], "exposures": [], "verdict": "READY"}), False)
check("missing verdict",
      ok({"run_id": "r", "seams_triaged": [], "exposures": []}), False)
check("null verdict",
      ok({"run_id": "r", "seams_triaged": [], "exposures": [], "verdict": None}), False)
check("empty-string verdict",
      ok({"run_id": "r", "seams_triaged": [], "exposures": [], "verdict": ""}), False)
check("seams_triaged not a list",
      ok({"run_id": "r", "seams_triaged": {}, "exposures": [], "verdict": "READY"}), False)
check("exposures not a list",
      ok({"run_id": "r", "seams_triaged": [], "exposures": None, "verdict": "READY"}), False)
check("a seam that is not an object",
      ok({"run_id": "r", "verdict": "READY", "exposures": [], "seams_triaged": ["oops"]}), False)
check("named_exposures wrong type (int)",
      ok({"run_id": "r", "verdict": "READY", "exposures": [],
          "seams_triaged": [{"class": "authz", "named_exposures": 3}]}), False)
check("review_result wrong type (int)",
      ok({"run_id": "r", "verdict": "READY", "exposures": [],
          "seams_triaged": [{"class": "authz", "review_result": 1}]}), False)

# ---- Loader (path / dir / bad JSON) -------------------------------------------------------------
print("D. Loader — path, missing file, invalid JSON")
check("non-existent path -> not well-formed",
      ok("/nonexistent/disposition.json"), False)

if failures:
    print(f"\nCONTRACT CONFORMANCE FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
