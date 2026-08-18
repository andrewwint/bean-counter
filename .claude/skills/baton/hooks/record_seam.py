#!/usr/bin/env python3
"""Manager-run seam recorder — arm the completeness gate for a seam triaged INLINE (no triage lane).

THE GAP IT CLOSES. SKILL.md permits the manager to triage INLINE for light work (no triage lane). But the
completeness gate only sees seams a triage LANE emitted via a `TRIAGE-SEAMS:` line captured by the
PostToolUse sidecar (`record_triaged_seams.py`). So when the manager names a sensitive seam inline, no
`TRIAGE-SEAMS` line exists, `triaged_seams.jsonl` stays empty, the ledger close-out falsely reads "no
sensitive seams", and the MISSING-RECORD safety net never arms — the seam is enforcement-invisible. This
recorder gives the manager the SAME machine path a triage lane uses: it appends the inline-named seam(s)
to `.agents/runs/triaged_seams.jsonl` through the validated parse+append the sidecar itself uses, so the
gate arms and the seam now owes a covering `disposition.json`.

DIRECTION OF EFFECT — it can only ADD an obligation, never remove one. Recording a seam makes a disposition
OWED; it never records a disposition or a clearance. So a manager cannot use it to fake a clean state — the
worst it does is force MORE verification. That is the safe direction, and why it is not itself a forge
risk. (The residual — a manager who names a seam and forgets to run this — is a prose obligation like any
other; the authoritative backstop stays the post-hoc scorer against the full stream. See SKILL.md.)

Run from the PROJECT ROOT (writes are cwd-relative, matching the hooks), naming seams in the TRIAGE-SEAMS
grammar — the same grammar, so the same fail-loud-on-malformed applies:

    python3 <skill>/hooks/record_seam.py "injection-sink@eval-site | secrets@iam-role"
    python3 <skill>/hooks/record_seam.py injection-sink@universe-eval

Exit 0 on a clean record; 2 on a usage error; 1 on a write failure.
"""
import os
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HOOKS_DIR)
import record_triaged_seams as rts  # noqa: E402  (co-located in the shipped skill)


def main(argv):
    if not argv:
        print('usage: record_seam.py "<class>[@<hint>] | <class>[@<hint>] ..."   (TRIAGE-SEAMS grammar; '
              'sensitive classes: ' + " ".join(sorted(rts.SENSITIVE_CLASSES)) + ")", file=sys.stderr)
        return 2
    payload = " ".join(argv).strip()
    # Parse through the SAME grammar as the triage sidecar (prepend the contract prefix so the shared
    # parser recognizes it) — so a malformed token fails loud here exactly as it would from a triage lane.
    result = rts.parse_triage_line(f"TRIAGE-SEAMS: {payload}")
    records = list(result["seams"])
    if result["malformed"]:
        records.append({"malformed": True, "raw": result.get("raw")})
    if not records:
        print(f"record_seam: no sensitive seam in {payload!r} — nothing recorded, the gate is unchanged. "
              "(A non-sensitive or empty token owes no disposition.)")
        return 0
    try:
        rts.append_records(records, task_id=None)
    except OSError as e:
        print(f"record_seam: could not write {rts.LEDGER}: {e}", file=sys.stderr)
        return 1
    parts = []
    if result["seams"]:
        named = ", ".join(r["class"] + (f"@{r['hint']}" if r.get("hint") else "") for r in result["seams"])
        parts.append(f"recorded {len(result['seams'])} sensitive seam(s) [{named}] — each now requires a "
                     f"covering disposition.json")
    if result["malformed"]:
        parts.append("recorded a MALFORMED marker — the gate will derive UNVERIFIED-SEAM (seams "
                     "indeterminate; fix the seam spelling/grammar and re-run, or resolve with a human)")
    print(f"record_seam: {' ; '.join(parts)}. Ledger: {rts.LEDGER}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
