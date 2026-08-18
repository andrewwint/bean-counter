import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Lightweight run ledger. Substantial routed work writes a run.json (+ summary.md)
 * under <ledgerBase>/<runId>/ — local working state, not committed product source.
 */
export interface RunRecord {
  runId: string;
  taskType: string; // the prompt
  repoPath: string;
  mode: "live" | "offline";
  status: string; // success | error | offline
  model?: string;
  effort?: string;
  costUsd?: number; // from the SDK result (total_cost_usd)
  startedAt: string;
  endedAt: string;
  lanes: string[]; // distinct lanes that reported
  summary?: string;
  error?: string;
  profile?: unknown; // offline repo profile
}

// Date.now()/Math.random() are fine here (this is the Node runtime, not a workflow script).
export function newRunId(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `run-${ts}-${rand}`;
}

// Returns the directory written, or "" when no ledger dir is configured (no-op).
// Persisting is opt-in (BATON_LEDGER_DIR); the caller gates on it too.
export async function writeLedger(
  baseDir: string | undefined,
  record: RunRecord
): Promise<string> {
  if (!baseDir) return "";
  const dir = path.join(baseDir, record.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify(record, null, 2) + "\n",
    "utf8"
  );
  if (record.summary) {
    await writeFile(path.join(dir, "summary.md"), record.summary + "\n", "utf8");
  }
  return dir;
}

// Default-on: the run ledger persists under <repoPath>/.agents/runs/ unless
// BATON_LEDGER_DIR overrides the location, or is set to "off" (case-insensitive)
// to disable persistence. Returns the base dir to write under, or undefined when
// persistence is disabled.
export function resolveLedgerBase(
  envVal: string | undefined,
  repoPath: string
): string | undefined {
  const v = envVal?.trim();
  if (v && v.toLowerCase() === "off") return undefined;
  if (v) return v;
  return path.join(repoPath, ".agents", "runs");
}
