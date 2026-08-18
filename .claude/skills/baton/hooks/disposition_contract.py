"""Standalone disposition.json CONTRACT checker — the shared predicate for three consumers: baton's deriver
omission gate, baton's doctor probe, and the harness's disposition-written assertion.

OWNERSHIP: neither repo owns this. It is vendored BYTE-IDENTICAL into the harness and into baton/baton; each
side pins `CONTRACT_SHA` (a conformance test recomputes it from this file's predicate and fails on drift), so
a change to one copy that isn't mirrored fails loudly in the copy that drifted. No import edge either
direction — this file imports NOTHING from the harness and NOTHING from baton/baton; pure stdlib only.

CONTRACT (ratified schema, task 5.2 — the same handshake as the REVIEWED-CLEAN string): a disposition record
is well-formed iff it carries the core fields (`run_id`, `seams_triaged` list, `exposures` list, non-null
`verdict`) and, WHERE PRESENT, the review-provenance fields are correctly typed — per sensitive seam,
`named_exposures` is a list (or a bare non-empty string = one finding) and `review_result` is a string. Those
two fields are exactly what the omission gate and doctor probe read; this checker asserts their SHAPE, never
the verdict (the deriver owns derivation). Shape-only, so it stays install-path- and version-agnostic.

COMPLETENESS SENTINEL (§1j). The completeness gate synthesizes a MISSING-RECORD sentinel record for a
sensitive seam triage flagged that no `disposition.json` covers (the invisible-skip failure). That sentinel
is DELIBERATELY a well-formed record under this same predicate — it carries `run_id`, a `seams_triaged`
list, an `exposures` list, and the non-null `verdict: "MISSING-RECORD"` — so every reader here (doctor's
shape probe, the eval scorer) consumes it with NO change. This checker asserts shape, not verdict value, so
the new terminal needs no predicate change and `CONTRACT_SHA` stays stable across the two vendored copies.
"""
import hashlib
import inspect
import json
from pathlib import Path

# Bump in BOTH vendored copies whenever `check`'s contract changes. The conformance test pins the sha of
# `check`'s source (not the whole file — avoids self-reference), so the two copies cannot silently diverge.
CONTRACT_VERSION = "1.0"

_REQUIRED = ("run_id", "seams_triaged", "exposures", "verdict")


def _load(record):
    """Accept a dict, a path to disposition.json, or a run dir containing one. Returns (rec|None, reason)."""
    if isinstance(record, dict):
        return record, "ok"
    p = Path(record)
    if p.is_dir():
        p = p / "disposition.json"
    if not p.is_file():
        return None, f"no disposition.json at {p}"
    try:
        return json.loads(p.read_text()), "ok"
    except (OSError, ValueError) as e:
        return None, f"unreadable/invalid JSON: {e}"


def check(record):
    """The contract predicate. `record` is a dict, a disposition.json path, or a run dir.
    Returns (ok: bool, reason: str) — ok=True iff the record is well-formed per the ratified contract."""
    rec, reason = _load(record)
    if rec is None:
        return False, reason
    for k in _REQUIRED:
        if k not in rec:
            return False, f"missing required field: {k}"
    if not rec.get("verdict"):
        return False, "verdict is null/empty"
    if not isinstance(rec.get("seams_triaged"), list):
        return False, "seams_triaged is not a list"
    if not isinstance(rec.get("exposures"), list):
        return False, "exposures is not a list"
    for i, s in enumerate(rec["seams_triaged"]):
        if not isinstance(s, dict):
            return False, f"seams_triaged[{i}] is not an object"
        ne = s.get("named_exposures")
        if ne is not None and not isinstance(ne, (list, str)):
            return False, f"seams_triaged[{i}].named_exposures must be a list or string, got {type(ne).__name__}"
        rr = s.get("review_result")
        if rr is not None and not isinstance(rr, str):
            return False, f"seams_triaged[{i}].review_result must be a string, got {type(rr).__name__}"
    return True, "ok"


def contract_sha():
    """sha256 of the predicate's source — the drift signal. Both vendored copies must produce the same value;
    the conformance test pins it. Keyed on `check` (+ helpers) so a formatting-only edit elsewhere is inert."""
    src = inspect.getsource(check) + inspect.getsource(_load)
    return hashlib.sha256(src.encode()).hexdigest()
