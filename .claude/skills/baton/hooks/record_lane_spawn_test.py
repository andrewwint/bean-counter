#!/usr/bin/env python3
"""Pin record_lane_spawn.spawn_from_event's id extraction against drift (review finding R1). This is the
ENFORCEMENT-path twin of ledger.lane_from_event: both MUST read `tool_response.agentId` then `tool_use_id`.
If they silently diverge, the deriver's id-reconciliation reverts to null while every other suite stays
green. Run: python3 record_lane_spawn_test.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import record_lane_spawn as R  # noqa: E402

failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures += 1


print("spawn_from_event id extraction (must mirror ledger.lane_from_event)")
check("tool_response.agentId is the primary id",
      R.spawn_from_event({"tool_name": "Agent", "tool_input": {"subagent_type": "researcher"},
                          "tool_response": {"agentId": "AG-1"}, "tool_use_id": "toolu_X"}),
      {"subagent_type": "researcher", "task_id": "AG-1"})
check("tool_use_id is the fallback when no agentId",
      R.spawn_from_event({"tool_name": "Task", "tool_input": {"subagent_type": "researcher"},
                          "tool_use_id": "toolu_Y"}),
      {"subagent_type": "researcher", "task_id": "toolu_Y"})
check("non-Task/Agent tool -> None",
      R.spawn_from_event({"tool_name": "Read", "tool_input": {}}), None)
check("no subagent_type -> None",
      R.spawn_from_event({"tool_name": "Task", "tool_input": {}}), None)
check("truthy non-dict tool_response tolerated (no crash, null id)",
      R.spawn_from_event({"tool_name": "Task", "tool_input": {"subagent_type": "researcher"},
                          "tool_response": 7}),
      {"subagent_type": "researcher", "task_id": None})

if failures:
    print(f"\nRECORD_LANE_SPAWN SELFTEST FAILED ({failures})")
    sys.exit(1)
print("\nALL PASS")
