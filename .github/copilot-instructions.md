# GitHub Copilot instructions

**Read [`AGENTS.md`](../AGENTS.md) first — it is the authoritative guidance for this repo**
(project purpose, layout, `make` targets, how to run tests). The data contract for events, the
read model, and the HTTP API is in
[`docs/architecture/slice-1-contract.md`](../docs/architecture/slice-1-contract.md).

Three rules are non-negotiable; `AGENTS.md` explains each one in full:

1. **Base units** — every quantity is an integer in a base unit (`g`, `ml`, `each`). No floats.
2. **Append-only** — the `events` table is `INSERT` only. Never `UPDATE`, never `DELETE`;
   correct a mistake by appending a new event.
3. **No secrets committed** — `.env` is gitignored; `.env.example` holds dev placeholders only.
