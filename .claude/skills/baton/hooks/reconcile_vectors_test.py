#!/usr/bin/env python3
"""Baton-side handshake test for the SHARED reconciliation vectors (`reconcile_vectors.json`).

The vectors file is vendored BYTE-IDENTICAL into both repos (baton + the eval harness); each side pins it
with a selftest. This side asserts baton's LIVE `reconciled_nongeneric` (disposition_gate.py) reproduces
every row's `expect`, AND that the fixture's recorded constants still match the live deriver — so a change to
the deriver's reconciliation (generics set, thresholds, or the token/id logic) that isn't mirrored into the
vectors fails HERE, and a vectors edit that isn't mirrored into eval fails on eval's side. Same shared-
assertion discipline as the vendored disposition-contract checker; the vectors ARE the handshake.

Run: python3 reconcile_vectors_test.py
"""
import json
import os
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import disposition_gate as dg  # noqa: E402

VECTORS = os.path.join(HOOKS_DIR, "reconcile_vectors.json")
failures = 0


def fail(msg):
    global failures
    print(f"  FAIL {msg}")
    failures += 1


doc = json.loads(open(VECTORS).read())

print("A. fixture constants match the live deriver")
if sorted(doc["generics_excluded"]) != sorted(dg.GENERIC_SUBAGENTS):
    fail(f"generics_excluded drifted: fixture={sorted(doc['generics_excluded'])} live={sorted(dg.GENERIC_SUBAGENTS)}")
else:
    print("  ok   generics_excluded == GENERIC_SUBAGENTS")
if doc["MIN_LANE_TOKEN"] != dg.MIN_LANE_TOKEN:
    fail(f"MIN_LANE_TOKEN drifted: {doc['MIN_LANE_TOKEN']} != {dg.MIN_LANE_TOKEN}")
else:
    print("  ok   MIN_LANE_TOKEN == 3")
if doc["MIN_TASK_ID"] != dg.MIN_TASK_ID:
    fail(f"MIN_TASK_ID drifted: {doc['MIN_TASK_ID']} != {dg.MIN_TASK_ID}")
else:
    print("  ok   MIN_TASK_ID == 8")

print("B. live reconciled_nongeneric reproduces every vector")
for v in doc["vectors"]:
    pairs = [(st, tid) for st, tid in v["spawns"]]
    got = dg.reconciled_nongeneric(v["ref"], pairs)
    if got != v["expect"]:
        fail(f"{v['label']!r}: fixture={v['expect']} live={got}")
    else:
        print(f"  ok   {'T' if v['expect'] else 'F'}  {v['label'][:72]}")

if failures:
    print(f"\nRECONCILE VECTORS HANDSHAKE FAILED ({failures}) — deriver and vectors have drifted; re-mirror both repos")
    sys.exit(1)
print(f"\nALL PASS ({len(doc['vectors'])} vectors, 0 drift)")
