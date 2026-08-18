#!/usr/bin/env python3
"""Close-out deriver: the verdict is authored by derive(), not by the model.

Wire as a Claude Code Stop hook (see SKILL.md, Approvals & Governance):

  {"hooks": {"Stop": [{"hooks": [{"type": "command",
      "command": "python3 .claude/skills/baton/hooks/disposition_gate.py"}]}]}}

The model populates FACTS in disposition.json (seams, exposures, contract sources, dispositions);
it does NOT author the verdict. This hook re-derives the verdict from those facts and STAMPS it into
the record — "derived, not declared" made literal. Blocking a wrong model-authored token was not
enough (a model dug in through 12 blocks and closed on the wrong verdict anyway: block != force);
removing the model's authorship removes the standoff. emitted == derived by construction.

Derivation is RECORD-ONLY at run time: self-disposed / laundered / undisposed / un-contracted -> not
READY; and, in reverse, a verified-clean, fully-contracted seam with no exposure -> READY (no
over-fire). A `contract_source: "specialist"` is honored when it names an independent (non-self)
lane; self / in-context / unnamed references are not a specialist.

Completeness (v8.5) + omission gate (v8.6): an un-contracted sensitive seam with no exposure is no longer a
single verdict. REVIEWED-CLEAN (provenance-limited, still not READY) names the honest "a real review lane
looked and found nothing, but not an independent specialist" middle — removing the incentive to skip the
record entirely (the MISSING-RECORD ~1/3 path, where the manager clears a seam and, facing an over-alarming
UNVERIFIED-SEAM, writes no disposition.json so the deriver never runs). It is granted for an honestly-
uncontracted seam a real review lane cleared (sidecar, forge-proof) with NO exposure named or found. The
shadow-export laundering — a diff-scoped review that NAMES a cross-tenant route then dismisses it "adds no
new exposure" and leaves exposures[] empty — is caught by the NAME-THEN-DISMISS OMISSION gate, NOT by a
blunt seam-scope classifier (which would re-alarm benign diff-reviewed clears to UNVERIFIED-SEAM and undo
§1j's win). A seam whose `review_result` is in the found-family, or whose `named_exposures` list is
non-empty, with the finding absent from exposures[] -> IDENTIFIED-UNRESOLVED (the exposure stands,
undisposed). A benign clean review names nothing, so it clears; only the launder's own tell fires.
HONEST SCOPE — the omission gate closes the launder ONLY when the review RECORDS the finding in the
structured fields (`named_exposures` / `review_result`); the SKILL.md naming->recording steer requires that.
It does NOT read `contract_evidence` PROSE, so a review that names an exposure only in prose (the ACTUAL
shadow-export record shape) and a deliberate omitter that records nothing are NOT caught here — those are the
POST-HOC scorer's job and the DEFERRED seam-scoped-consult-run root's (the inconsistent-spawn cause). Reading
`contract_evidence` for exposure prose is pre-registered but held pending eval's launder + benign-control
records to calibrate it against over-fire (tasks.md §1k). This is the same reduces-not-closes trust boundary
as the sidecar: the deriver reads what the record honestly states; it cannot cross-examine prose.

WHY NOT verify the lane actually spawned here: the Stop hook's `transcript_path` does NOT reliably
contain the subagent's `task_started` at stamp time (a run-time-vs-post-hoc divergence dev-orch
isolated: post-hoc matching on the captured stream honors the lane, the run-time transcript does
not — timing, or a differing id representation). A run-time downgrade on that unreliable input
returned an empty/incomplete lane set and over-fired EVERY genuine contract to UNVERIFIED-SEAM
(both benign and defect). So stream authenticity — "did the claimed specialist lane really spawn" —
is the POST-HOC layer's job (the eval scorer's spoof_specialist check against the captured stream,
whose input is reliable), NOT the run-time hook's. The hook still records a non-authoritative
`_stream_diag` (what the Stop-time transcript showed) so the divergence stays observable per run.

In-product fabrication gap — REDUCED (not closed) at run time by the sidecar (1.2.0). The exposure the
record-only deriver could not disprove was run-time fabrication of `contract_source: "specialist"`
with a plausible `contract_lane` and no real lane behind it. The `record_lane_spawn.py` PostToolUse
sidecar records REAL Task/Agent spawns to `.agents/runs/lane_spawns.jsonl` — a signal the model cannot
forge by NARRATING (only an actual tool-use fires it). When the sidecar is wired (see
`sidecar_real_spawns` / settings.json), the deriver honors a claimed specialist ONLY if its
`contract_lane` matches a really-recorded spawn; an unbacked claim downgrades to UNVERIFIED-SEAM. This
is the run-time counterpart to the post-hoc `spoof_specialist` check, on input the hook can trust — and
it is why v8.2's transcript-based downgrade was WRONG but this one is safer: the sidecar is written at
spawn time (PostToolUse), so at Stop it reliably contains the spawn; a genuine contract is honored (no
over-fire), only an unbacked claim is caught. HONEST LIMITS (an independent /code-review, 2026-07-03):
this REDUCES, it does not close — `subagent_type` is model-authored, so a no-op consult can still forge
a qualifying spawn, and the ledger is session-scoped with no seam binding, so one real spawn can cover
several seams. The POST-HOC scorer (did the lane do work / examine THIS seam) stays authoritative.
Over-fire dependency: the run-time downgrade is only safe if the recording path fires — the PostToolUse
matcher must cover the real spawn tool (`Task|Agent`), the hook must be staged in the run's cwd, and
writes must not be lost (append-only JSONL). Any gap → empty ledger → over-fire; hence the downgrade is
gated on the sidecar being wired. When NOT wired the deriver falls back to record-only. Trust boundary:
the sidecar proves a lane SPAWNED, not that it did good work — depth lives in the lane and post-hoc.

The model's own token is preserved as `verdict_emitted` with a `verdict_incoherent` flag — a soft
quality signal (how often the model emits a verdict its own facts contradict), never the gate.
Exit 0 after stamping; exit 2 only on an unusable (unreadable / unwritable) record.
"""
import glob
import json
import os
import re
import sys

VERDICTS = {"READY", "NOT-READY", "IDENTIFIED-UNRESOLVED", "UNVERIFIED-SEAM", "ACCEPTED-WITH-NOTE",
            "REVIEWED-CLEAN", "MISSING-RECORD"}
INDEPENDENT_SOURCES = {"specialist", "external-plan", "human"}
LAUNDER_SOURCES = {"ticket", "implementer-claim", "self-plan"}
SENSITIVE_CLASSES = {"tenant-isolation", "data-egress", "authz", "writes-mutations",
                     "auth-gate", "secrets", "injection-sink"}
# Lane identifiers that are NOT an independent security specialist.
NON_INDEPENDENT_LANES = {None, "", "self", "manager", "in-context", "skill", "main"}
GENERIC_SUBAGENTS = {"general-purpose", "code-reviewer", "implementer", "triage", "researcher",
                     "Explore", "Plan"}
# The ALLOWLIST of lanes whose spawn is evidence that a review actually ran — the forge-proof signal that
# lets an honestly-uncontracted, exposure-free sensitive seam derive REVIEWED-CLEAN ("a review looked and
# found nothing, but not an independent specialist") instead of UNVERIFIED-SEAM ("nobody verified it").
# `code-reviewer` is included (the observed review vehicle); `security-review` is the bundled security lane.
# Deliberately an allowlist, NOT "any non-generic lane": a project's non-review specialist (`refactor-bot`,
# `perf-tuner`) is not a review. The SHADOW-EXPORT laundering (a diff-scoped review that named a cross-tenant
# route then dismissed it "adds no new exposure", exposures[] empty) is NOT closed by tightening this to
# seam-scoped-only — that bluntly re-alarms benign diff-reviewed clears to UNVERIFIED-SEAM and undoes §1j's
# whole win (removing the over-loud verdict). It is closed instead by the PRECISE name-then-dismiss OMISSION
# gate in derive() (a benign clean review does not name-then-dismiss a violation), so this stays broad.
REVIEW_CAPABLE_LANES = {"code-reviewer", "security-review"}
# Generic worker-lane names distinctive enough to detect inside a free-text `contract_lane` without
# false-matching security prose. A `contract_source: "specialist"` whose contract_lane names one of
# these is a spoof — the run did security "review" via a generic worker lane, not an independent
# security specialist (the r2 gap: a specialist claim naming `code-reviewer`, honored record-only).
# Deliberately EXCLUDES the common-word generics `triage`/`Explore`/`Plan` (would false-match prose
# like "triaged the seam" / "the plan's invariants" and over-fire a benign contract); those are
# instead caught by the sidecar's reconciliation when wired (a generic lane never reconciles as a specialist).
GENERIC_LANE_SPOOF_TOKENS = {"code-reviewer", "general-purpose", "implementer", "researcher"}

LANE_SPAWNS_PATH = os.path.join(".agents", "runs", "lane_spawns.jsonl")
# The forge-proof triage seam-ledger the completeness gate reads (record_triaged_seams.py sidecar).
TRIAGED_SEAMS_PATH = os.path.join(".agents", "runs", "triaged_seams.jsonl")
# The reserved run dir the completeness gate writes its MISSING-RECORD sentinel into. It looks like any
# other run's record (so the deriver/doctor/eval scorer read it unchanged) but is EXCLUDED from
# coverage-counting so it never counts as covering itself.
COMPLETENESS_RUN_DIR = "_completeness"
SETTINGS_PATH = os.path.join(".claude", "settings.json")
# A recorded lane NAME token must be at least this long to be usable (a 1-2 char name would be too weak).
MIN_LANE_TOKEN = 3
# A recorded task_id is matched by SUBSTRING (opaque, any charset incl. '_'); it must be at least this long
# so a short id can't accidentally substring-collide with unrelated contract text. Real ids are 20+ chars.
MIN_TASK_ID = 8


def read_hook_input():
    """Return the Stop hook's stdin JSON (transcript_path, cwd, ...) or {} if none/unparseable."""
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}


def spawned_specialist_lanes(transcript_path):
    """Parse the transcript for independent specialist lanes that actually spawned.

    Returns (available, lanes) where `available` is False when the transcript can't be read
    (caller then falls back to record-only), and `lanes` is a set of identifiers a valid
    specialist contract may cite: subagent_types (excluding generics) and their task ids.
    """
    if not transcript_path:
        return (False, set())
    try:
        lines = open(transcript_path).read().splitlines()
    except OSError:
        return (False, set())
    lanes = set()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        # A genuine independent lane is a spawned subagent Task, not a Skill invocation.
        if o.get("type") == "system" and o.get("subtype") == "task_started":
            st = o.get("subagent_type")
            if st and st not in GENERIC_SUBAGENTS:
                lanes.add(st)
                if o.get("task_id"):
                    lanes.add(o.get("task_id"))
    return (True, lanes)


def _candidate_settings(settings_path):
    """The settings.json file(s) to consult for a wired-hook signal. An EXPLICIT path (tests) is checked
    ALONE. The production default (None) checks the PROJECT settings, the project-LOCAL settings, AND the
    USER-GLOBAL `~/.claude/settings.json` — because the INTERACTIVE `/baton` path wires the enforcement
    hooks GLOBALLY (via `hooks/wire_interactive.py`), not in a per-project settings.json. Reading only the
    project file made the deriver believe the sidecars were unwired on every interactive run in an ordinary
    repo, so `sidecar_real_spawns` returned None (record-only) and the completeness gate went silent — the
    hooks fired and recorded, but the deriver could not SEE that they were wired, so it did not trust them
    (observed live: `_sidecar_diag.enforcement_active: false` with a real spawn in `lane_spawns.jsonl`)."""
    if settings_path is not None:
        return [settings_path]
    return [
        SETTINGS_PATH,                                             # project (cwd-relative)
        os.path.join(".claude", "settings.local.json"),           # project-local
        os.path.join(os.path.expanduser("~"), ".claude", "settings.json"),  # user-global (interactive path)
    ]


def _hook_wired(needle, settings_path):
    """True iff a PostToolUse hook command containing `needle` is wired in ANY candidate settings.json."""
    for p in _candidate_settings(settings_path):
        try:
            cfg = json.loads(open(p).read())
        except (OSError, ValueError):
            continue
        if not isinstance(cfg, dict):
            continue
        for entry in cfg.get("hooks", {}).get("PostToolUse", []) or []:
            for h in (entry.get("hooks", []) if isinstance(entry, dict) else []) or []:
                if isinstance(h, dict) and needle in (h.get("command") or ""):
                    return True
    return False


def sidecar_enforcement_active(settings_path=None):
    """True iff the `record_lane_spawn` PostToolUse sidecar is wired (project, local, OR user-global). This
    is an INSTALL-time signal (settings.json, not model-authored per run), so it is trustworthy: when the
    sidecar is wired, an absent/empty spawn ledger genuinely means no independent lane spawned — so a claimed
    specialist is a fabrication — whereas when it is NOT wired the deriver must fall back to record-only (it
    cannot tell a missing ledger from an uninstalled hook)."""
    return _hook_wired("record_lane_spawn", settings_path)


def recorded_spawns(path=LANE_SPAWNS_PATH):
    """All spawns from the append-only JSONL sidecar ledger, as `(subagent_type, task_id)` pairs —
    RAW and unfiltered (generics included), so the deriver can RECONCILE a `contract_lane` to a specific
    spawn and then require that spawn's `subagent_type` be non-generic (eval's design). An absent ledger
    yields `[]`; a corrupt line is skipped, not fatal."""
    spawns = []
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return spawns
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            s = json.loads(line)
        except ValueError:
            continue
        spawns.append((s.get("subagent_type"), s.get("task_id")))
    return spawns


def _ref_tokens(ref_l):
    """`[a-z0-9-]+` token set of a lowercased reference — for EXACT (equality) matching of lane NAMES."""
    return set(re.findall(r"[a-z0-9-]+", ref_l))


def reconciled_nongeneric(ref_l, spawns):
    """True iff the lowercased lane reference `ref_l` RECONCILES to a recorded spawn whose `subagent_type`
    is a KNOWN non-generic lane. A spawn certifies a specialist only when its `subagent_type` is present and
    non-generic (never None/unknown — that would let a task_id launder an unattributed lane). Matching is
    asymmetric by design:
      - NAME (`subagent_type`): token-EQUALITY (must EQUAL a `[a-z0-9-]+` token of the ref). A short/common
        recorded name like 'sec'/'review' cannot substring-false-match 'secrets'/'reviewed' prose, and a
        look-alike 'security-reviewer' is a different token than 'security-review'.
      - ID (`task_id`): SUBSTRING of the raw ref (with a >= MIN_TASK_ID floor). Task ids are long and opaque,
        so substring is collision-safe AND charset-agnostic — real Claude ids contain '_' ('toolu_01Qmk…'),
        which the name tokenizer would split, so an id must be matched whole against the raw text, not as a
        token. This is what makes a name-less opaque-id `contract_lane` reconcile (the id<->name unification).
    A reference reconciling only to generic lanes, or to nothing, is not a specialist."""
    ref_tokens = _ref_tokens(ref_l)
    for st, tid in spawns:
        if not st or st in GENERIC_SUBAGENTS:
            continue  # only a KNOWN non-generic lane can certify a specialist (no None, no generic)
        st_l = str(st).lower()
        if len(st_l) >= MIN_LANE_TOKEN and st_l in ref_tokens:
            return True  # NAME: exact token
        if tid:
            tid_l = str(tid).lower()
            if len(tid_l) >= MIN_TASK_ID and tid_l in ref_l:
                return True  # ID: opaque + long -> substring (handles '_' and any charset)
    return False


def sidecar_real_spawns(settings_path=None, ledger_path=LANE_SPAWNS_PATH):
    """The recorded spawns to reconcile against, or None for record-only.
    None -> sidecar not wired; honor a claimed specialist on record facts + the text guard (fallback).
    list -> sidecar wired; honor a claimed specialist ONLY if its lane reference reconciles to a recorded
            NON-generic spawn (an empty list means nothing real spawned -> every claim is unbacked)."""
    if not sidecar_enforcement_active(settings_path):
        return None
    return recorded_spawns(ledger_path)


def triage_sidecar_active(settings_path=None):
    """True iff the `record_triaged_seams` PostToolUse sidecar is wired (project, local, OR user-global).
    Like `sidecar_enforcement_active`, this is an INSTALL-time signal (settings.json, not model-authored per
    run), so it is trustworthy: when the triage sidecar is wired, an absent/empty triage ledger genuinely
    means no sensitive seam was triaged — so the completeness gate can safely stay silent. When it is NOT
    wired the gate must NOT fire (it cannot tell an empty ledger from an uninstalled hook, exactly the
    over-fire trap the spawn sidecar guards against). Checking the user-global settings too is what keeps the
    completeness gate live on the INTERACTIVE path, where the sidecar is wired globally, not per-project."""
    return _hook_wired("record_triaged_seams", settings_path)


def recorded_triaged_seams(path=TRIAGED_SEAMS_PATH):
    """The sensitive seams a real triage lane returned, from the append-only sidecar ledger, as a list of
    {class, hint} dicts. An absent ledger yields `[]`; a corrupt line is skipped, not fatal. Filters to the
    sensitive taxonomy defensively (the sidecar already filters, but the gate must not trust a stray class)."""
    seams = []
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return seams
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            s = json.loads(line)
        except ValueError:
            continue
        if s.get("class") in SENSITIVE_CLASSES:
            seams.append({"class": s.get("class"), "hint": s.get("hint")})
    return seams


def _malformed_markers(path=TRIAGED_SEAMS_PATH):
    """The MALFORMED marker records ({malformed: true, raw: ...}) the triage sidecar ledgered (Condition 1).
    Absent/corrupt ledger -> []; a corrupt line is skipped, not fatal."""
    out = []
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("malformed"):
            out.append(r)
    return out


def triage_malformed(path=TRIAGED_SEAMS_PATH):
    """True iff the triage sidecar ledgered a MALFORMED marker — a TRIAGE-SEAMS line whose tokens did not
    parse. A malformed line means the seam list is INDETERMINATE; the gate must fail loud (UNVERIFIED-SEAM),
    never treat the unparseable part as "no seam owed"."""
    return bool(_malformed_markers(path))


def malformed_sentinel(raw=None):
    """Build the UNVERIFIED-SEAM sentinel for a malformed triage line (Condition 1). Well-formed under the
    vendored shape contract (run_id, seams_triaged list, exposures list, non-null verdict), authored/pre-
    stamped like the MISSING-RECORD sentinel. Fail-loud: the seam list is indeterminate, so no coverage or
    class-less-sensitive record can clear it — human attention is required.

    `seams_triaged` is deliberately EMPTY: there is no trustworthy per-seam class to name (the line did not
    parse), and the spec documents a seam's `class` as a string — a placeholder `class: None` would violate
    that shared shape for a strict reader. The `_completeness.triage_malformed` marker carries the meaning."""
    return {
        "run_id": COMPLETENESS_RUN_DIR,
        "seams_triaged": [],
        "exposures": [],
        "verdict": "UNVERIFIED-SEAM",
        "verdict_basis": (
            "triage output malformed, seams indeterminate — the TRIAGE-SEAMS line did not parse"
            + (f" (raw: {raw!r})" if raw else "")
            + "; the sensitive-seam list cannot be trusted, so READY is not reachable and human attention is "
            "required. The malformed marker persists in the append-only session ledger, so it dominates for "
            "the rest of this session: fix the triage return-format line (see agents/triage.md) AND reset "
            "`.agents/runs/triaged_seams.jsonl` (or start a fresh session) before re-running."
        ),
        "_completeness": {"triage_malformed": True, "raw": raw, "triage_sidecar": True},
        "_stamped": True,
    }


def completeness_uncovered(triaged_seams, covered_classes):
    """The sensitive CLASSES triage named that no disposition record covers. Class-PRESENCE, not per-seam
    identity: a haiku triage `hint` and a record's seam label do not reconcile reliably, so the gate asserts
    the coarse-but-robust obligation — every sensitive class triage flagged must appear in SOME record's
    seams_triaged. This catches the dominant MISSING-RECORD failure (a class cleared with NO record at all,
    covered set empty) without over-firing on a second seam of an already-covered class. Honest scope, same
    reduces-not-closes boundary as the spawn sidecar: a within-class partial drop is the post-hoc scorer's job."""
    triaged_classes = {s.get("class") for s in triaged_seams if s.get("class") in SENSITIVE_CLASSES}
    return sorted(triaged_classes - set(covered_classes))


def completeness_sentinel(uncovered_classes, triaged_seams):
    """Build the MISSING-RECORD sentinel record. It is a WELL-FORMED disposition record (passes
    `disposition_contract.check`: run_id, seams_triaged list, exposures list, non-null verdict) so every
    downstream reader — the deriver's idempotence skip, doctor's shape probe, the eval scorer — consumes it
    unchanged. It is pre-stamped (`_stamped`) and carries an authored `MISSING-RECORD` verdict: this is a
    COMPLETENESS terminal, not a contract derivation, so derive() must never re-run on it. The uncovered
    seams are listed sensitive so the record reads honestly as governing sensitive surface."""
    return {
        "run_id": COMPLETENESS_RUN_DIR,
        "seams_triaged": [
            {"class": c, "sensitive": True, "contract_source": "none", "_uncovered": True}
            for c in uncovered_classes
        ],
        "exposures": [],
        "verdict": "MISSING-RECORD",
        "verdict_basis": (
            "triage flagged sensitive seam class(es) that no disposition.json covers: "
            + ", ".join(uncovered_classes)
            + " — a sensitive seam was cleared without recording a disposition (the invisible skip); "
            "the record's existence is mandatory, so this is a completeness failure, not READY"
        ),
        "_completeness": {
            "triaged_classes": sorted({s.get("class") for s in triaged_seams
                                       if s.get("class") in SENSITIVE_CLASSES}),
            "uncovered_classes": uncovered_classes,
            "triage_sidecar": True,
        },
        "_stamped": True,
    }


def reviewed_by_a_real_lane(real_spawns):
    """True iff the sidecar recorded a spawn of an actual REVIEW lane (`REVIEW_CAPABLE_LANES`) — the
    forge-proof evidence that a review really ran, so an honestly-uncontracted, exposure-free sensitive seam
    can derive REVIEWED-CLEAN instead of UNVERIFIED-SEAM. Gated on the review-lane allowlist, NOT "any
    non-generic lane": a project's non-review specialist (`refactor-bot`, `perf-tuner`, `db-migrator`) is not
    a review. None or an empty ledger -> no proof a review ran -> NOT REVIEWED-CLEAN (record-only cannot grant
    it). Only an actual review-lane tool-use fires this — the model cannot forge it by narrating. The
    diff-vs-seam scope of that review is NOT gated here (that bluntly re-alarms benign clears); the launder is
    caught by the name-then-dismiss OMISSION gate in derive() instead."""
    if not real_spawns:
        return False
    return any(st in REVIEW_CAPABLE_LANES for st, _ in real_spawns)


def _lane_ref(obj):
    """Lowercased text naming the contracting lane, from `contract_lane` + `contract_evidence` (the model
    may name it in either; r2's spoof named it only in `contract_evidence`). Names are matched by token
    EQUALITY and ids by SUBSTRING against this text — see `reconciled_nongeneric`."""
    return " ".join(str(obj.get(k) or "") for k in ("contract_lane", "contract_evidence")).lower()


def effective_contract_source(obj, real_spawns=None):
    """Effective SEAM contract_source (the seam names its contracting lane in `contract_lane` /
    `contract_evidence`). A 'specialist' claim is honored only when it resolves to an INDEPENDENT SECURITY
    lane:
      - unnamed, or an explicit self/in-context lane (NON_INDEPENDENT_LANES) -> not a specialist;
      - **sidecar wired (`real_spawns` is a list):** authoritative — the lane tokens must RECONCILE to a
        recorded NON-generic spawn (`reconciled_nongeneric`). Stronger than a token blocklist and unifies
        the spoof reject with the id<->name fragility. r2's spoof cell was sidecar-wired with an EMPTY
        ledger, so it reconciles to nothing -> not a specialist;
      - **record-only (`real_spawns is None`):** no spawns to reconcile against, so fall back to the weaker
        `GENERIC_LANE_SPOOF_TOKENS` text guard, matched by token EQUALITY (a generic name is one of the
        lane tokens). Calibrated: the common-word generics triage/Explore/Plan are excluded (they would hit
        prose like 'triaged the seam'). Exposure dispositions use `_exposure_independent`, not this (an
        exposure's `contract_evidence` may be a doc pointer, not the lane name — see that function)."""
    src = obj.get("contract_source")
    if src != "specialist":
        return src
    lane = obj.get("contract_lane")
    ref_l = _lane_ref(obj)
    if not ref_l.strip():
        return "none"  # no lane named in either field
    if lane in NON_INDEPENDENT_LANES and lane not in (None, ""):
        return "none"  # explicit self / in-context / skill / manager / main
    if real_spawns is not None:  # sidecar wired: authoritative positive reconciliation
        return src if reconciled_nongeneric(ref_l, real_spawns) else "none"
    # record-only fallback: the weaker text guard, token-equality (eval: keep as the no-sidecar fallback)
    if _ref_tokens(ref_l) & GENERIC_LANE_SPOOF_TOKENS:
        return "none"  # a lane token IS a generic worker lane -> spoof
    return src


def _exposure_independent(exposure, real_spawns):
    """Whether an exposure's disposition rests on an INDEPENDENT contract. Unlike a seam, an exposure does
    not reliably NAME its disposing lane (its `contract_evidence` may be a pointer to invariants, not the
    lane), so a specialist disposition is NOT reconciled to a named lane — that would over-fire genuine
    work. Instead: a `human` / `external-plan` disposition is independent as recorded; a **specialist**
    disposition — keyed on EITHER the disposer OR the source, so a `specialist` disposer cannot dodge the
    check by labeling the source `human` — is independent only if a real non-generic security lane actually
    spawned in the run (sidecar). Record-only falls back to trusting the label. This catches the r2 exposure
    spoof (sidecar wired, empty ledger -> no specialist spawned -> the disposition does not stick) without
    over-firing a genuine one."""
    src = exposure.get("contract_source")
    if src not in INDEPENDENT_SOURCES:
        return False
    if "specialist" not in (src, exposure.get("disposer")):
        return True  # a purely human / external-plan disposition needs no spawn
    if real_spawns is None:
        return True  # record-only: no spawn record to check, trust the label (weaker fallback)
    return any(st and st not in GENERIC_SUBAGENTS for st, _ in real_spawns)


def is_sensitive(seam):
    """Sensitivity is class-determined: any seam whose class is in the sensitive taxonomy is
    sensitive regardless of a 'sensitive: false' flag (kills the demotion dodge)."""
    return seam.get("class") in SENSITIVE_CLASSES or bool(seam.get("sensitive"))


def _named_findings(seam):
    """The findings a review NAMED (`named_exposures`), normalized to a list. A bare non-empty string is
    treated as one finding; anything falsy (None, "", []) is no findings — so a malformed empty-string does
    not read as benign only by luck, it reads as empty explicitly. (NB: whether a named finding is genuinely
    UNRECORDED — the omission trigger — is decided by `_unrecorded_named_findings`, not here.)"""
    v = seam.get("named_exposures")
    if not v:
        return []
    return [v] if isinstance(v, str) else (list(v) if isinstance(v, (list, tuple, set)) else [v])


def _recorded_exposure_refs(exposures):
    """Lowercased id / summary / location strings of every RECORDED exposure — used to decide whether a
    `named_exposures` entry corresponds to a finding the run actually recorded (so it is not a drop)."""
    refs = []
    for e in exposures or []:
        for k in ("id", "summary", "location"):
            v = e.get(k)
            if v:
                refs.append(str(v).lower())
    return refs


def _unrecorded_named_findings(seam, exposures):
    """The named findings that are genuinely UNRECORDED — the omission trigger (eval's safe-direction steer).
    A `named_exposures` entry is EXCLUDED (treated as recorded, so it does not fire) when it plausibly
    corresponds to a recorded exposure — its text and some recorded exposure's id/summary/location contain one
    another (case-insensitive). So a finding the review both named AND properly recorded+disposed does NOT
    over-fire to IDENTIFIED-UNRESOLVED (it flows to ACCEPTED-WITH-NOTE via the normal exposure path); only a
    named finding with NO recorded counterpart — the actual name-then-drop — fires. Safe-direction: an empty
    `exposures` (the shadow-export shape) has no refs, so every named finding is unrecorded and still fires."""
    named = _named_findings(seam)
    if not named:
        return []
    refs = _recorded_exposure_refs(exposures)
    out = []
    for n in named:
        nl = str(n).lower().strip()
        if nl and any(r in nl or nl in r for r in refs):
            continue  # corresponds to a recorded exposure -> not a drop
        out.append(n)
    return out


def _review_found_exposure(seam):
    """True iff the seam's `review_result` says the review FOUND an exposure. Case- and separator-insensitive
    (records are model-written): 'exposure-found' / 'EXPOSURE-FOUND' / 'exposure_found' / 'exposures found' /
    'found' all fire. A benign 'clean' / null / unknown value does NOT fire — the match is an allowlist of the
    found-family, not "anything non-clean", so an unfamiliar benign value cannot re-alarm a clean review."""
    rr = seam.get("review_result")
    if not rr:
        return False
    norm = re.sub(r"[^a-z]", "", str(rr).lower())  # strip case + separators -> 'exposurefound' / 'found'
    return norm in {"exposurefound", "exposuresfound", "found"}


def derive(record, real_spawns=None):
    """Deterministically derive the verdict the record supports; return (verdict, reason).

    `real_spawns` gates specialist-contract authenticity: None -> record-only (text-guard fallback); a
    list of recorded `(subagent_type, task_id)` spawns -> sidecar wired, and a claimed specialist is
    honored only if its lane reference reconciles to a recorded NON-generic spawn (an empty list fails
    every claim). Everything else is a record fact and derives identically."""
    exposures = record.get("exposures") or []
    seams = record.get("seams_triaged") or []
    sensitive = [s for s in seams if is_sensitive(s)]

    for e in exposures:
        if e.get("contract_source") in LAUNDER_SOURCES:
            return ("IDENTIFIED-UNRESOLVED",
                    f"exposure '{e.get('id')}' cites contract_source={e.get('contract_source')} — "
                    "a laundering source is not a valid contract")
        if e.get("disposer") == "self":
            return ("IDENTIFIED-UNRESOLVED",
                    f"exposure '{e.get('id')}' was disposed by the run itself — "
                    "the finding lane never disposes")

    # OMISSION (v8.6, name-then-dismiss) — checked on EVERY sensitive seam, BEFORE any READY/REVIEWED-CLEAN
    # path, so neither an un-contracted seam nor a specialist-contracted one can launder a named-but-dropped
    # finding into a clean verdict (the /code-review found a specialist-contracted named-then-drop deriving
    # READY). A benign clean review names nothing, so neither signal fires on it (no re-alarm). Two signals:
    #   - `named_exposures` with a genuinely UNRECORDED entry (`_unrecorded_named_findings`): a finding the
    #     review NAMED with no corresponding recorded exposure. A named finding that IS also recorded+disposed
    #     is excluded (flows to ACCEPTED-WITH-NOTE), so a properly-handled finding is not over-fired — eval's
    #     safe-direction scoping. An empty exposures[] (the shadow-export shape) still fires on every named one.
    #   - `review_result` in the found-family AND NOTHING is recorded in exposures[]: the review says it found
    #     an exposure but the run recorded none. Gated on `not exposures` so a genuinely recorded-and-disposed
    #     exposure (ACCEPTED-WITH-NOTE) whose seam honestly reports `review_result: exposure-found` is NOT
    #     over-fired back to IDENTIFIED-UNRESOLVED.
    # HONEST SCOPE: both signals read the record's STRUCTURED fields only. A launder that names the exposure
    # solely in `contract_evidence` PROSE (the actual shadow-export record shape), or a deliberate omitter that
    # records nothing, is NOT caught here — post-hoc + the deferred seam-scoped-consult root own those. See the
    # module docstring and tasks.md §1k; do not read this gate as closing the prose/omitter variants.
    if any(_unrecorded_named_findings(s, exposures) for s in sensitive):
        return ("IDENTIFIED-UNRESOLVED",
                "a review named a sensitive-seam exposure (named_exposures) it did not record in exposures[] — "
                "name-then-dismiss omission; the exposure stands, undisposed")
    if not exposures and any(_review_found_exposure(s) for s in sensitive):
        return ("IDENTIFIED-UNRESOLVED",
                "a review recorded review_result='exposure-found' but the run recorded no exposure — "
                "name-then-dismiss omission; the exposure stands, undisposed")

    # An exposure is disposed only by an independent disposer whose contract is independent — a specialist
    # disposition needs a real non-generic security lane to have spawned (see _exposure_independent), so a
    # spoofed `specialist` disposition (r2: sidecar wired, empty ledger) does NOT count.
    undisposed = [e for e in exposures
                  if not (e.get("disposition") == "disposed-acceptable"
                          and e.get("disposer") in {"human", "specialist"}
                          and _exposure_independent(e, real_spawns))]
    accepted = [e for e in exposures
                if e.get("disposition") == "disposed-acceptable"
                and e.get("disposer") in {"human", "specialist"}
                and _exposure_independent(e, real_spawns)]

    if undisposed:
        if any(e.get("disposition") == "escalated-pending" or e.get("disposition") in (None, "none")
               for e in undisposed):
            return ("IDENTIFIED-UNRESOLVED",
                    f"{len(undisposed)} exposure(s) lack an independent disposition")

    # Seam-level rule (record-only): a sensitive seam without an independent contract can never
    # support READY.
    uncontracted_seams = [s for s in sensitive
                          if effective_contract_source(s, real_spawns) not in INDEPENDENT_SOURCES]
    if uncontracted_seams and not exposures:
        # (The name-then-dismiss OMISSION is already handled above, over every sensitive seam.)
        # REVIEWED-CLEAN (v8.5 grant, retained — this is what keeps benign clears from re-alarming): every
        # uncontracted seam honestly recorded `contract_source` in {None, "none"} (a REJECTED claim — spoofed
        # specialist, laundering source, or junk — keeps the full UNVERIFIED-SEAM penalty), AND a REAL review
        # lane cleared it (sidecar, forge-proof), AND no omission tell fired above. Record-only stays
        # UNVERIFIED-SEAM (cannot prove a review ran).
        all_honest_none = all(s.get("contract_source") in (None, "none") for s in uncontracted_seams)
        if all_honest_none and reviewed_by_a_real_lane(real_spawns):
            return ("REVIEWED-CLEAN",
                    f"{len(uncontracted_seams)} sensitive seam(s) honestly recorded no contract, a real review "
                    "lane cleared them with no exposure named or found — provenance-limited, not READY")
        return ("UNVERIFIED-SEAM",
                f"{len(uncontracted_seams)} sensitive seam(s) carry no independent contract_source — "
                "'no exposures found' on an un-contracted seam is not READY")
    if exposures and not undisposed:
        if uncontracted_seams:
            return ("IDENTIFIED-UNRESOLVED",
                    "disposed exposures but un-contracted sensitive seam(s) remain")
        return ("ACCEPTED-WITH-NOTE" if accepted else "READY", None)
    if not exposures:
        # No exposures and every sensitive seam independently contracted -> READY is the DERIVABLE
        # verdict, so a conservative token here (UNVERIFIED-SEAM / IDENTIFIED-UNRESOLVED) asserts a
        # non-verification the record contradicts. The over-fire backstop: derive READY so main()
        # can block the incoherent conservative token. (No sensitive seams at all -> not our concern.)
        if sensitive and not uncontracted_seams:
            return ("READY",
                    "every sensitive seam carries a satisfied independent contract and no exposure "
                    "was identified — a positive safety check, so READY is the derivable verdict")
        return (None, None)
    return ("IDENTIFIED-UNRESOLVED", "undisposed exposure(s) present")


def stamp(path, record):
    """Write the record back atomically-ish (temp + replace)."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(record, f, indent=2)
    os.replace(tmp, path)


def stream_diag(record, lanes_available, lanes):
    """Non-authoritative: what the Stop-time transcript showed about specialist lanes, so the
    run-time-vs-post-hoc divergence (is the task_started present + id-matched at stamp time?) is
    observable on every record. NOT used to derive the verdict."""
    seams = [s for s in (record.get("seams_triaged") or []) if is_sensitive(s)]
    claimed = [str(s.get("contract_lane")) for s in seams
               if s.get("contract_source") == "specialist" and s.get("contract_lane")]
    return {
        "transcript_available": lanes_available,
        "runtime_specialist_lanes": sorted(str(l) for l in lanes),
        "specialist_contract_lanes_claimed": claimed,
        "runtime_lane_matched": {c: any(str(l) in c for l in lanes) for c in claimed},
    }


def main():
    hook_input = read_hook_input()
    lanes_available, lanes = spawned_specialist_lanes(hook_input.get("transcript_path"))
    real_spawns = sidecar_real_spawns()  # None (record-only) or a list of recorded spawns (sidecar wired)

    problems = []
    covered_classes = set()  # sensitive classes any REAL record covers — the completeness gate reads this
    # A record may mark a seam sensitive with a bare `sensitive: true` and NO class (is_sensitive honors
    # that — the demotion-dodge guard). Such a seam covers sensitive surface but names no class to key on,
    # so it cannot fill a specific class in `covered_classes`. Track it separately and let it SUPPRESS the
    # gate: a record exists and derive() already governed it (→ UNVERIFIED-SEAM at worst, never READY on an
    # un-contracted seam), so the invisible skip did NOT happen — firing MISSING-RECORD here would over-fire
    # a genuinely-recorded run. Dodging the gate this way buys nothing (the class-less seam still eats its
    # derived verdict); the class-keyed catch stays for the real failure — NO covering record at all.
    covered_classless_sensitive = False
    for path in glob.glob(".agents/runs/*/disposition.json"):
        # The completeness sentinel is a record too; never let it count as covering itself, and never
        # re-derive it (its MISSING-RECORD verdict is authored, not derived).
        if os.path.basename(os.path.dirname(path)) == COMPLETENESS_RUN_DIR:
            continue
        try:
            record = json.loads(open(path).read())
        except (OSError, json.JSONDecodeError) as err:
            problems.append(f"{path}: unreadable disposition record ({err})")
            continue
        # Every real record's sensitive seams count toward coverage — even one already stamped by a prior
        # Stop (coverage is about the record's EXISTENCE, independent of the idempotence skip below).
        for s in (record.get("seams_triaged") or []):
            if not is_sensitive(s):
                continue
            if s.get("class"):
                covered_classes.add(s.get("class"))
            else:
                covered_classless_sensitive = True  # sensitive surface recorded, but no class to key on
        # Idempotent: a Stop hook re-globs EVERY run's record on every stop. Skip records already
        # finalized by a prior stamp — re-deriving is harmless, but re-reading `verdict` as the
        # "emitted" token would clobber the model's original with the derived value and zero the
        # incoherence signal for every run but the latest.
        if record.get("_stamped"):
            continue
        derived, reason = derive(record, real_spawns)  # authoritative for the verdict
        if derived is None:
            continue  # no sensitive seam -> the deriver does not govern this run's verdict
        # The verdict is authored by derive(), not the model. Stamp it; preserve the model's token
        # (captured ONCE, before overwrite) as a quality signal — verdict_incoherent = the model
        # emitted a verdict its own facts contradict.
        emitted = record.get("verdict")  # the model's token, only on the first stamp
        record["verdict"] = derived
        record["verdict_emitted"] = emitted
        record["verdict_incoherent"] = bool(emitted is not None and emitted != derived)
        if reason:
            record["verdict_basis"] = reason
        record["_stream_diag"] = stream_diag(record, lanes_available, lanes)  # observability, not the gate
        record["_sidecar_diag"] = {  # observability: what the reliable sidecar showed and enforced
            "enforcement_active": real_spawns is not None,
            "recorded_spawns": [{"subagent_type": st, "task_id": tid} for st, tid in (real_spawns or [])],
        }
        record["_stamped"] = True
        try:
            stamp(path, record)
        except OSError as err:
            problems.append(f"{path}: could not write the derived verdict ({err})")

    # COMPLETENESS GATE (§1j structural half): make the record's EXISTENCE mandatory, not a prose
    # obligation. The loop above only governs runs that WROTE a disposition.json; the MISSING-RECORD skip
    # writes none, so the glob is empty and the deriver never runs — the invisible skip. This gate closes
    # that by reading the forge-proof triage seam-ledger (record_triaged_seams.py sidecar) instead of the
    # record: a sensitive CLASS triage flagged that no record covers derives a MISSING-RECORD sentinel — a
    # present, contract-valid, non-READY artifact the eval scorer/doctor read, so the skip is detectable.
    # Gated on the sidecar being WIRED (settings.json, trustworthy) — unwired, an empty ledger cannot be
    # told from an uninstalled hook, so the gate stays silent rather than over-fire (the spawn sidecar's
    # exact trust boundary). Escalate-don't-override is untouched: this gate only detects ABSENCE; it never
    # disposes a finding or overrides the specialist.
    sentinel_dir = os.path.join(".agents", "runs", COMPLETENESS_RUN_DIR)
    sentinel_path = os.path.join(sentinel_dir, "disposition.json")
    if triage_sidecar_active():
        triaged = recorded_triaged_seams()
        # Condition 1 (fail-loud) DOMINATES: a malformed TRIAGE-SEAMS line means the seam list is
        # indeterminate — we cannot trust coverage OR the class-less-sensitive suppression, so the only
        # honest verdict is UNVERIFIED-SEAM. Checked first so a malformed line is never silently cleared.
        if triage_malformed():
            raw = next((r.get("raw") for r in _malformed_markers() if r.get("raw")), None)
            try:
                os.makedirs(sentinel_dir, exist_ok=True)
                stamp(sentinel_path, malformed_sentinel(raw))
            except OSError as err:
                problems.append(f"{sentinel_path}: could not write the malformed-triage sentinel ({err})")
        else:
            # A class-less sensitive record covers unattributable sensitive surface -> suppress (see above):
            # the record exists and derive() governed it, so there is no invisible skip to flag.
            uncovered = [] if covered_classless_sensitive else completeness_uncovered(triaged, covered_classes)
            if uncovered:
                try:
                    os.makedirs(sentinel_dir, exist_ok=True)
                    stamp(sentinel_path, completeness_sentinel(uncovered, triaged))
                except OSError as err:
                    problems.append(f"{sentinel_path}: could not write the completeness sentinel ({err})")
            elif os.path.exists(sentinel_path):
                # Every triaged class is now covered — clear a stale sentinel so a later complete run does
                # not inherit a false MISSING-RECORD (a no-op in a hermetic one-run-per-workspace trial).
                try:
                    os.remove(sentinel_path)
                except OSError:
                    pass  # best-effort cleanup; a stale sentinel is a visible flag, never a silent pass

    if problems:
        sys.stderr.write(
            "disposition_gate: could not finalize the disposition record.\n"
            + "\n".join(f"  - {p}" for p in problems) + "\n")
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
