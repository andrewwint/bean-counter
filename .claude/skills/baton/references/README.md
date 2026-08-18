# `references/` — make baton match your org's SDLC

This folder is the **org extension point**. The base skill is intentionally generic; drop your organization's SDLC docs here and the manager consults them on demand when a relevant topic comes up. With nothing here (just this README), the skill behaves generically — no change for a single developer.

These files are **instructions, not secret stores** — never put credentials or tokens in them.

Your `references/*.md` are **org-private**: they live in your copy of the skill, not the public base, and are not expected to travel with upstream updates.

## Where these live

`references/` sits in the skill directory, next to `SKILL.md` (`.claude/skills/baton/references/`). The manager reads them from the installed skill — defined for when the skill is installed into the repo you're working in (interactive Claude Code, or the runtime run against that repo). Surfacing these into a headless runtime run against a *different* `--cwd` is a known gap; keep references with the skill in the repo under work.

## Suggested taxonomy (adapt freely — split, merge, or rename)

- **`Workflow.md`** — ticketing system, branch and PR conventions, approval routing, ticket linkage.
- **`Platform.md`** — CI/CD, deploy targets, environments, secret stores, infra signals (containers, pipelines).
- **`Acceptance.md`** — definition of done, required checks, review gates, closeout evidence. For a change with a running surface (HTTP API, web UI, CLI), this is also where you require **behavioral acceptance** — drive the running app end to end, not only unit tests.
- **`Security.md`** — org security posture: what is gated, what is forbidden, who approves.

Keep each file **focused and short** — they're loaded on demand, so smaller files mean less context per task. One topic per file beats one monolith.

## Example: a starter `Workflow.md`

A good one is short and specific — concrete, checkable rules, not prose. Start from something like this and edit to your team's truth:

```markdown
# Workflow

- **Tickets:** every change links a Jira key (`PROJ-123`); put it in the branch and the PR title.
- **Branches:** `feature/PROJ-123-short-desc` or `bugfix/PROJ-123-short-desc`, off `develop`.
- **PRs:** target `develop`; require 2 approvals and green CI; squash-merge.
- **Never:** push straight to `main`; force-push a shared branch.
```

`Platform`, `Acceptance`, and `Security` follow the same shape — a few concrete rules the coordinator can actually check against.

## Example: behavioral acceptance for a running surface

Unit tests alone can pass over a feature a person cannot actually use — a green suite that never started the server. When a change has a running surface, an `Acceptance.md` can route a behavioral lane so the manager proves it end to end. This is an extension pattern, not core behavior: a backend-only or library project simply omits it.

```markdown
# Acceptance

- **Behavioral check:** for a change to a running surface (HTTP API, web UI, CLI), open a behavioral
  lane that starts the app and exercises the acceptance criteria end to end, alongside unit verification.
- **Browser UI:** drive it with Playwright (or your e2e tool) against a seeded test identity; record the
  run as closeout evidence. It never replaces unit tests — it is the out-of-sample check at the
  running-system layer.
- **Test identity:** use a dedicated test account with no MFA prompt; never put credentials in this file.
```

## Precedence

References customize **how** work is done. They do **not** silently relax the skill's core safety posture: outward-facing actions stay approval-gated and the developer stays the credited author — unless a reference *explicitly* defines its own approval authority.
