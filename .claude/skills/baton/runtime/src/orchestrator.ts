import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { query, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { loadLanes, parseFrontmatter } from "./lanes.js";
import { detectRepo, type RepoProfile } from "./offline.js";
import { newRunId, writeLedger, resolveLedgerBase, type RunRecord } from "./ledger.js";
import { discoverMcpServers } from "./mcp.js";
import { envAlias } from "./env.js";

/**
 * baton runtime.
 *
 * Runs the manager-led orchestrator loop headlessly via the Claude Agent SDK.
 * The skill is self-contained: lane agents (agents/*.md) are registered
 * PROGRAMMATICALLY via the `agents` option and the skill body is injected as
 * the system prompt — so the runtime does NOT depend on `.claude/agents/` or
 * `.claude/skills/` existing in the target repo.
 *
 * Orchestration is coordinator / hub-and-spoke: this loop is the manager,
 * lanes are bounded workers that report back. There is no peer-to-peer mesh.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url)); // runtime/src (dev) or runtime/dist (built)
const SKILL_ROOT = path.resolve(HERE, "..", "..");         // skill dir (agents/, SKILL.md)

// Headless override: the injected SKILL.md describes interactive primitives
// (plan mode, SendMessage, human approval) that have no approver in a query()
// run. This neutralizes them for the runtime path without editing the
// dual-purpose skill, while still protecting outward-facing actions.
const HEADLESS_NOTE = `## Runtime mode (headless)
You are running headlessly via the baton runtime; no human is watching in real time. Do not wait for interactive approval, use plan mode, or rely on SendMessage — those gates have no approver here. Proceed autonomously on reversible work. Do NOT perform outward-facing or irreversible actions (push, PR or ticket changes, deletions); finish the reversible work and report those as recommended follow-ups for the developer.`;

interface CliArgs {
  prompt: string;
  cwd: string;
  offline: boolean;
  noSkill: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let cwd = process.cwd();
  let offline = false;
  let noSkill = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd" || arg === "-C") {
      cwd = args[++i] ?? cwd;
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--no-skill") {
      noSkill = true;
    } else {
      rest.push(arg);
    }
  }
  return { prompt: rest.join(" ").trim(), cwd, offline, noSkill };
}

function hasCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS ||
      process.env.CLAUDE_CODE_USE_VERTEX ||
      process.env.CLAUDE_CODE_USE_FOUNDRY
  );
}

function profileLine(label: string, items: string[]): string {
  return `  ${label.padEnd(12)} ${items.length ? items.join(", ") : "—"}`;
}

// Offline mode: deterministic repo detection + lane registry, no model call.
async function runOffline(
  prompt: string,
  cwd: string,
  agentsDir: string
): Promise<{ report: string; profile: RepoProfile }> {
  const profile: RepoProfile = await detectRepo(cwd);
  const lanes = await loadLanes(agentsDir);

  const out: string[] = [
    `task: ${prompt}`,
    `repo: ${profile.cwd}`,
    "",
    "repo profile (deterministic, no model call):",
    profileLine("runtimes", profile.runtimes),
    profileLine("manifests", profile.manifests),
    profileLine("containers", profile.containers),
    profileLine("ci", profile.ci),
    profileLine("guidance", profile.guidance),
    profileLine(
      "commands",
      Object.entries(profile.commands).map(([k, v]) => `${k}: ${v}`)
    ),
    profileLine("top level", profile.topLevel),
    "",
    "lanes available (would delegate in a live run):",
    ...Object.entries(lanes).map(
      ([name, def]) => `  ${name.padEnd(14)} model=${def.model ?? "inherit"}`
    ),
    "",
    "(offline: no model call. Set ANTHROPIC_API_KEY and drop --offline for a live run.)",
  ];
  return { report: out.join("\n"), profile };
}

// Run ledger is on by default: the run summary and cost always print to stdout, and
// a persisted run.json (+ summary.md) lands under <repo>/.agents/runs/ for every
// completed run. BATON_LEDGER_DIR overrides the location; BATON_LEDGER_DIR=off
// disables persistence. A ledger write failure never flips an otherwise-successful run.
async function safeWriteLedger(record: RunRecord): Promise<void> {
  const baseDir = resolveLedgerBase(envAlias("LEDGER_DIR"), record.repoPath);
  if (!baseDir) return;
  try {
    const dir = await writeLedger(baseDir, record);
    process.stdout.write(`ledger: ${dir}\n`);
  } catch (err) {
    process.stderr.write(
      `[ledger] could not write run ledger: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

async function main(): Promise<void> {
  const { prompt, cwd, offline: forceOffline, noSkill } = parseArgs(process.argv);

  if (!prompt) {
    console.error(
      "Usage: npm run orchestrate -- <task prompt> [--cwd <target repo path>] [--offline]"
    );
    process.exit(1);
  }

  // Credentials/config come from the real environment, or from a .env loaded by
  // the npm scripts via `node --env-file-if-exists=.env` (see package.json).

  const agentsDir = path.join(SKILL_ROOT, "agents");
  const startedAt = new Date();
  const runId = newRunId(startedAt);

  // Offline when asked explicitly, or when no credentials are available —
  // a deterministic repo-detection pass instead of failing the run.
  if (forceOffline || !hasCredentials()) {
    if (!forceOffline) {
      console.error(
        "[offline] no credentials found — running deterministic repo detection only.\n"
      );
    }
    const { report, profile } = await runOffline(prompt, cwd, agentsDir);
    process.stdout.write(report + "\n\n");
    await safeWriteLedger({
      runId,
      taskType: prompt,
      repoPath: cwd,
      mode: "offline",
      status: "offline",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      lanes: [],
      summary: report,
      profile,
    });
    return;
  }

  // Register the bundled lanes in-process (no .claude/agents/ dependency).
  const agents = await loadLanes(agentsDir);

  // Inject the skill's orchestration contract as the system prompt.
  const { body: skillBody } = parseFrontmatter(
    await readFile(path.join(SKILL_ROOT, "SKILL.md"), "utf8")
  );

  // Auto-allow list: these skip permission prompts. It does NOT restrict the
  // toolset (use `tools` for that) — the manager keeps the full default set.
  // Agent delegates to lanes; Workflow handles large fan-outs (TS SDK >=0.3.149).
  const allowedTools = [
    "Agent",
    "Workflow",
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "Edit",
    "Write",
  ];

  // permissionMode: keep edits flowing headlessly while the skill still gates
  // outward-facing actions. Override with BATON_PERMISSION (validated; bad
  // values fall back to the default rather than reaching the SDK).
  const PERMISSION_MODES = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
  ];
  const permEnv = envAlias("PERMISSION");
  const permissionMode = (
    PERMISSION_MODES.includes(permEnv ?? "") ? permEnv : "acceptEdits"
  ) as PermissionMode;

  // Cost levers (env-overridable, validated). The manager loop dominates cost, so
  // default it to Sonnet (not Opus) at medium effort with a turn cap. Cheap
  // read-only runs: BATON_MODEL=haiku BATON_EFFORT=low. Hardest work:
  // BATON_MODEL=opus BATON_EFFORT=xhigh. ('inherit' is a lane-only value,
  // not a valid top-level model, so it falls back to the default here.)
  const modelEnv = envAlias("MODEL");
  const model = modelEnv && modelEnv !== "inherit" ? modelEnv : "sonnet";
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
  const effortEnv = envAlias("EFFORT");
  const effort = ((EFFORTS as readonly string[]).includes(effortEnv ?? "")
    ? effortEnv
    : "medium") as (typeof EFFORTS)[number];
  const maxTurnsRaw = Math.floor(Number(envAlias("MAX_TURNS")));
  const maxTurns =
    Number.isInteger(maxTurnsRaw) && maxTurnsRaw > 0 ? maxTurnsRaw : 40;

  // MCP discovery (manager-only; default off). Read the project's standard
  // .mcp.json — the platform's location, no baton-specific variable — and
  // precisely allowlist each declared server's tools (mcp__<name>__*) so the
  // headless loop can call them without a permission prompt that has no approver.
  // Per-server allowlisting (not a mcp__* wildcard) keeps the blast radius bounded
  // to exactly the discovered servers; the discovery is logged so it stays auditable.
  const mcpServers = discoverMcpServers(cwd);
  const mcpNames = Object.keys(mcpServers);
  for (const name of mcpNames) {
    allowedTools.push(`mcp__${name}__*`);
  }
  if (mcpNames.length) {
    process.stdout.write(
      `[mcp] discovered ${mcpNames.length} server(s) from .mcp.json: ${mcpNames.join(", ")}\n`
    );
  }

  const lanesReported: string[] = [];
  let finalSummary = "";
  let status = "success";
  let runError = "";
  let costUsd: number | undefined;

  const stream = query({
    prompt,
    options: {
      cwd,
      model,
      effort,
      maxTurns,
      agents: noSkill ? {} : agents,
      allowedTools,
      permissionMode,
      ...(mcpNames.length ? { mcpServers } : {}),
      // Forward subagent prose to the stream so lane output and the reported-lane
      // count actually appear (default emits only subagent tool_use/tool_result).
      forwardSubagentText: true,
      // Worktree isolation is not a query() option: background lanes default to
      // worktree isolation (bgIsolation: 'worktree'), and the manager requests it
      // per parallel implementation lane via the Agent tool `isolation: "worktree"`
      // parameter (see SKILL.md). Configure symlink/sparse behavior in the target
      // repo's .claude/settings.json if needed.
      // Baseline (--no-skill): plain Claude Code with only the headless
      // operability floor — no Baton skill body, no lanes — so an eval isolates
      // Baton's contribution rather than the headless-vs-interactive difference.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: noSkill ? HEADLESS_NOTE : `${skillBody}\n\n${HEADLESS_NOTE}`,
      },
    },
  });

  try {
    for await (const message of stream) {
      const msg = message as any;

      if (msg.type === "assistant") {
        const fromLane = msg.parent_tool_use_id as string | undefined;
        // Prefer the readable lane name; fall back to the spawn id if absent.
        const laneName = (msg.subagent_type as string | undefined) ?? fromLane;
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            if (fromLane && laneName) lanesReported.push(laneName);
            process.stdout.write(block.text);
          }
          if (
            block.type === "tool_use" &&
            (block.name === "Agent" || block.name === "Task")
          ) {
            process.stdout.write(
              `\n[lane spawned: ${block.input?.subagent_type ?? "?"}]\n`
            );
          }
        }
      }

      if (msg.type === "result") {
        if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
        const distinct = new Set(lanesReported).size;
        if (msg.subtype === "success") {
          finalSummary = msg.result ?? "";
          process.stdout.write(`\n\n=== run complete ===\n${finalSummary}\n`);
          if (distinct) process.stdout.write(`lanes that reported: ${distinct}\n`);
        } else {
          status = "error";
          runError = Array.isArray(msg.errors)
            ? msg.errors.join("; ")
            : String(msg.subtype);
          process.stderr.write(`\n\n=== run failed (${msg.subtype}) ===\n${runError}\n`);
          process.exitCode = 1;
        }
      }
    }
  } catch (err) {
    status = "error";
    runError = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n\n=== run errored ===\n${runError}\n`);
    process.exitCode = 1;
  }

  if (typeof costUsd === "number") {
    process.stdout.write(`cost: $${costUsd.toFixed(4)}\n`);
  }

  await safeWriteLedger({
    runId,
    taskType: prompt,
    repoPath: cwd,
    mode: "live",
    status,
    model,
    effort: String(effort),
    costUsd,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    lanes: [...new Set(lanesReported)],
    summary: finalSummary || undefined,
    error: runError || undefined,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
