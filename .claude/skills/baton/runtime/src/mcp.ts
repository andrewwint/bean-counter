import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

// A well-formed MCP server name — the `<name>` in `mcp__<name>__<tool>`. Restricting
// discovery to these keeps each auto-allowed tool pattern exact and the blast radius
// bounded; a server whose name falls outside this set is skipped, never widened over.
const SERVER_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Discover MCP servers from the project's standard `.mcp.json` — the platform's own
 * location, the same file interactive Claude Code reads. baton has no MCP variable of
 * its own; it uses what the project already configures.
 *
 * Reads `<cwd>/.mcp.json`, accepts the SDK's mcpServers shape (a top-level `mcpServers`
 * key or a bare server map), and returns the server map keyed by name, keeping only
 * well-formed names. Fails soft: a missing / invalid / empty config degrades to lexical
 * navigation and never throws.
 */
export function discoverMcpServers(cwd: string): Record<string, McpServerConfig> {
  const file = path.join(cwd, ".mcp.json");
  if (!existsSync(file)) return {};

  let raw: unknown;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw =
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "mcpServers" in parsed
        ? (parsed.mcpServers as unknown)
        : parsed;
  } catch (err) {
    process.stderr.write(
      `[mcp] could not parse ${file}: ${err instanceof Error ? err.message : String(err)} — continuing without MCP.\n`
    );
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!SERVER_NAME.test(name)) {
      process.stderr.write(
        `[mcp] skipping server with unsupported name ${JSON.stringify(name)} in ${file}.\n`
      );
      continue;
    }
    out[name] = cfg as McpServerConfig;
  }
  return out;
}
