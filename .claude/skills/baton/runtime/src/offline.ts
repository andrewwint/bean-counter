import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic repo detection — the offline analog of the discovery lane.
 * No model call: it reads the target repo's files to produce a repo profile,
 * mirroring the "Repo Detection" section of the skill.
 */

const MANIFESTS: Record<string, string> = {
  "package.json": "Node.js",
  "requirements.txt": "Python",
  "pyproject.toml": "Python",
  "pom.xml": "Java (Maven)",
  "build.gradle": "Java/Kotlin (Gradle)",
  Gemfile: "Ruby",
  "composer.json": "PHP",
  "go.mod": "Go",
  "Cargo.toml": "Rust",
};

export interface RepoProfile {
  cwd: string;
  runtimes: string[];
  manifests: string[];
  ci: string[];
  containers: string[];
  guidance: string[];
  commands: Record<string, string>;
  topLevel: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectRepo(cwd: string): Promise<RepoProfile> {
  const manifests: string[] = [];
  const runtimes: string[] = [];
  for (const [file, rt] of Object.entries(MANIFESTS)) {
    if (await exists(path.join(cwd, file))) {
      manifests.push(file);
      runtimes.push(rt);
    }
  }

  const ci: string[] = [];
  for (const f of ["Jenkinsfile", ".gitlab-ci.yml"]) {
    if (await exists(path.join(cwd, f))) ci.push(f);
  }
  if (await exists(path.join(cwd, ".github/workflows"))) ci.push(".github/workflows");

  const containers: string[] = [];
  for (const f of ["Dockerfile", "docker-compose.yml", "compose.yaml"]) {
    if (await exists(path.join(cwd, f))) containers.push(f);
  }

  const guidance: string[] = [];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    if (await exists(path.join(cwd, f))) guidance.push(f);
  }

  const commands: Record<string, string> = {};
  if (manifests.includes("package.json")) {
    try {
      const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
      const s = (pkg.scripts ?? {}) as Record<string, string>;
      if (s.build) commands.build = "npm run build";
      if (s.test) commands.test = "npm test";
      if (s.lint) commands.lint = "npm run lint";
    } catch {
      /* unreadable/invalid package.json — skip command hints */
    }
  }

  let topLevel: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const e of entries) {
      if (/^README/i.test(e.name)) guidance.push(e.name);
    }
    topLevel = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    /* unreadable cwd — leave topLevel empty */
  }

  return {
    cwd,
    runtimes: [...new Set(runtimes)],
    manifests,
    ci,
    containers,
    guidance,
    commands,
    topLevel,
  };
}
