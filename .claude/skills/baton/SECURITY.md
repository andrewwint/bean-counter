# Security

Baton is a Claude Code skill: markdown instructions plus an optional TypeScript runtime. This note states its security-relevant surface so a reviewer or scanner has the triage in writing.

## Shape and surface

- **Inspectable source only.** The skill is plain text: markdown, TypeScript, JSON, and one shell script. There are no binaries, minified bundles, or encrypted files. A scan that reports files as "opaque" or "low confidence" is failing to read text source (often its own analyzer backend), not finding obfuscated content.
- **No network surface in the shipped skill.** Nothing in the installed skill makes network calls. The eval and measurement tooling that calls a model API lives in the repository's `tools/` directory, which is not part of the distributable skill.
- **One filesystem read.** The only file read in the shipped skill is `runtime/src/mcp.ts`, which reads the project's standard `.mcp.json` (the same file Claude Code uses) to discover configured MCP servers. The path is fixed (`<repo>/.mcp.json`), not derived from untrusted input; it is off when no `.mcp.json` is present, allowlists only exact well-formed server names, and fails soft.
- **One runtime dependency.** The optional runtime depends only on `@anthropic-ai/claude-agent-sdk`, plus standard dev tooling (`typescript`, `tsx`, `@types/node`). `runtime/package-lock.json` is an auto-generated lockfile: plain text and benign, and large enough that it may exceed a scanner's per-file size limit simply by being a lockfile.

## What the runtime does

- The optional runtime runs an AI agent with real tools (Read/Edit/Write/Bash) within Claude Code's permission model. Run it on code you are willing to let an agent change.
- Outward-facing actions (push, PRs, deletions, deploys) are approval-gated; the human stays the credited author.
- Model calls go only to the configured provider (by default `https://api.anthropic.com`), gated on the operator's `ANTHROPIC_API_KEY`. There is no telemetry; nothing else leaves the machine.
- MCP servers configured in the project's `.mcp.json` launch local commands (for example Serena). Baton allowlists exactly the declared, well-formed server names and logs them; put only servers you trust in `.mcp.json`. Off when none are configured.

## Eval and development tooling

Baton's eval, bench, fault-catch, and conformance scripts are development and measurement tooling. They live in the repository's `tools/` directory, outside the installed skill, so they are not part of what an installation carries or a scanner of the skill sees.

## Reporting

Report security concerns through the repository's issue tracker, or a private channel if the maintainer provides one.
