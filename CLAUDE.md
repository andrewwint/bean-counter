# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first — it is the authoritative guidance for this repo.**
Project purpose, the base-unit rule, the append-only rule, event versioning, the layout map, the
`make` targets, and how to run tests all live there. Nothing is restated here, so the two files
cannot drift apart.

The data contract (event table, event types, read-model formula, HTTP API) is in
[`docs/architecture/slice-1-contract.md`](./docs/architecture/slice-1-contract.md).

## Claude Code specifics

The [Baton](https://github.com/andrewwint/baton) skill is vendored at `.claude/skills/baton/`.
Invoke it with `/baton` for multi-step work — it plans the work into lanes and runs review passes
before anything is called done. Treat the vendored copy as read-only.
