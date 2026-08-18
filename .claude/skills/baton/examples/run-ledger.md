# Example: Run Ledger for a Multi-Lane Feature

A concrete picture of the trail substantial routed work leaves. Trivial / direct work
produces only a closing summary — no ledger. The boundary is loop steps, not edit size:
three or more loop steps earns at least a minimal entry.

The bundled runtime writes this automatically when a ledger directory is configured
(`BATON_LEDGER_DIR`, opt-in): a `run.json` plus an optional `summary.md` under
`<ledgerDir>/<runId>/`. For interactive runs without the runtime, keep the same shape by
hand under `.agents/runs/<runId>/`. The fields below are exactly the runtime's `RunRecord`
(`runtime/src/ledger.ts`).

## run.json

```json
{
  "runId": "run-2026-06-26T14-30-00-000Z-a1b2c",
  "taskType": "Add OpenID Connect login replacing the stub auth",
  "repoPath": "/home/dev/project",
  "mode": "live",
  "status": "success",
  "model": "sonnet",
  "effort": "medium",
  "costUsd": 0.4821,
  "startedAt": "2026-06-26T14:30:00.000Z",
  "endedAt": "2026-06-26T14:47:12.000Z",
  "lanes": ["triage", "Explore", "Plan", "implementer", "code-reviewer", "researcher"],
  "summary": "OIDC login implemented across 4 slices; two review lenses, both findings fixed; tests green. PR draft prepared (approval-gated, not pushed)."
}
```

## Lane Progression

| Step | Lane | Disposition / Deliverable |
|------|------|---------------------------|
| triage | `triage` | delegated — touches the auth seam (risk trigger), needs discovery first |
| discovery | `Explore` | mapped: Express app, session middleware, 3 route files, no existing OIDC |
| plan | `Plan` | 4 slices: provider config, callback route, session integration, guard middleware |
| implement | `implementer` | 4 files changed, build passes |
| verify (briefed) | `code-reviewer` | found a hardcoded default secret (critical) |
| verify (cold read) | `code-reviewer` | found a fail-open on a missing env var (medium) |
| recover | `implementer` | both findings fixed, full suite green |
| verify (re-check) | `code-reviewer` | pass |

## Checkpoints

1. `intake-ready` — acceptance criteria captured
2. `plan-ready` — 4-slice plan approved
3. `implementation-ready` — all slices built
4. `verified` — both review lenses pass
5. `closed` — summary written, PR draft prepared (approval-gated)

## Why two verify rows

The seam is high-stakes, so verification used two lenses (see The Loop, step 5). The
**briefed** reviewer caught the critical hardcoded secret. The **cold read** — given only
the spec and the diff, none of the manager's hypotheses — caught a medium fail-open the
briefed pass missed: `OIDC_STRICT` defaulted to `false` when unset, silently disabling
token validation. A brief the manager writes narrows the reviewer to the manager's blind
spots; an un-briefed pass keeps the estimate out-of-sample. That second lens is the point.
