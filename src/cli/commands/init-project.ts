import fs from "node:fs/promises";
import path from "node:path";
import { type LanguageModel, generateText } from "ai";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const MAX_ENTRIES = 20;
const README_HEAD_LINES = 5;

export interface ProjectFacts {
  name: string | null;
  dirName: string;
  packageManager: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  commands: {
    test: string | null;
    build: string | null;
    lint: string | null;
    typecheck: string | null;
  };
  hasTsconfig: boolean;
  isGitRepo: boolean;
  readmeHead: string[];
  entries: string[];
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

interface PackageJson {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PackageJson;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

async function detectPackageManager(cwd: string): Promise<string | null> {
  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(cwd, "package-lock.json"))) return "npm";
  if (await fileExists(path.join(cwd, "bun.lockb"))) return "bun";
  return null;
}

function inferCommands(
  pm: string | null,
  scripts: Record<string, string>,
): ProjectFacts["commands"] {
  const runner = pm ?? "npm";
  const pick = (script: string): string | null =>
    script in scripts ? `${runner} ${script}` : null;
  return {
    test: pick("test"),
    build: pick("build"),
    lint: pick("lint"),
    typecheck: pick("typecheck"),
  };
}

async function listEntries(cwd: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(cwd, { withFileTypes: true });
    const entries: string[] = [];
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) continue;
        entries.push(`${dirent.name}/`);
      } else if (!dirent.name.startsWith(".")) {
        entries.push(dirent.name);
      }
      if (entries.length >= MAX_ENTRIES) break;
    }
    return entries.sort();
  } catch {
    return [];
  }
}

async function readReadmeHead(cwd: string): Promise<string[]> {
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, README_HEAD_LINES);
    } catch {
      // try the next candidate name
    }
  }
  return [];
}

export async function scanProject(cwd: string): Promise<ProjectFacts> {
  const pkg = await readPackageJson(cwd);
  const packageManager = await detectPackageManager(cwd);
  const scripts = stringRecord(pkg?.scripts);
  return {
    name: typeof pkg?.name === "string" ? pkg.name : null,
    dirName: path.basename(cwd),
    packageManager,
    scripts,
    dependencies: Object.keys(stringRecord(pkg?.dependencies)),
    devDependencies: Object.keys(stringRecord(pkg?.devDependencies)),
    commands: inferCommands(packageManager, scripts),
    hasTsconfig: await fileExists(path.join(cwd, "tsconfig.json")),
    isGitRepo: await fileExists(path.join(cwd, ".git")),
    readmeHead: await readReadmeHead(cwd),
    entries: await listEntries(cwd),
  };
}

export function renderAgentsMd(facts: ProjectFacts): string {
  const title = facts.name ?? facts.dirName;
  const lines: string[] = [
    "# AGENTS.md",
    "",
    "Guidance for AI agents working in this repository.",
    "",
    "## Project",
    "",
    facts.readmeHead.length > 0 ? facts.readmeHead.join(" ") : `${title}`,
    "",
  ];
  const commandLines: string[] = [];
  const push = (label: string, command: string | null) => {
    if (command) commandLines.push(`- \`${command}\` — ${label}`);
  };
  push("run tests", facts.commands.test);
  push("build", facts.commands.build);
  push("lint", facts.commands.lint);
  push("typecheck", facts.commands.typecheck);
  if (commandLines.length > 0) {
    lines.push("## Commands", "", ...commandLines, "");
  }
  lines.push("## Layout", "");
  for (const entry of facts.entries) {
    lines.push(`- \`${entry}\``);
  }
  lines.push("", "## Conventions", "");
  const conventions: string[] = [];
  if (facts.hasTsconfig) conventions.push("TypeScript project (tsconfig.json present).");
  if (facts.packageManager) conventions.push(`Use ${facts.packageManager} as the package manager.`);
  if (facts.isGitRepo) conventions.push("Git repository.");
  if (facts.dependencies.length > 0) {
    conventions.push(`Key dependencies: ${facts.dependencies.slice(0, 10).join(", ")}.`);
  }
  if (conventions.length === 0) conventions.push("No conventions detected yet — fill this in.");
  for (const item of conventions) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}

const INIT_SYSTEM_PROMPT = [
  "You are writing an AGENTS.md file that guides AI coding agents working in a repository.",
  "You are given scanned project facts as JSON.",
  "Produce a concise Markdown document with sections: Project, Commands, Layout, Conventions.",
  "Keep commands exactly as given in the facts. Do not invent tools, scripts, or directories.",
  "Output only the Markdown, no preamble, no code fences.",
].join("\n");

async function polishWithModel(facts: ProjectFacts, model: LanguageModel): Promise<string | null> {
  const { text } = await generateText({
    model,
    system: INIT_SYSTEM_PROMPT,
    prompt: `Project facts:\n\n${JSON.stringify(facts, null, 2)}\n\nWrite the AGENTS.md.`,
  });
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface InitProjectOptions {
  cwd: string;
  args: string;
  model: LanguageModel | null;
}

export interface InitProjectResult {
  message: string;
  written: boolean;
  path: string;
  lines: number;
  usedLlm: boolean;
}

export async function initProject(opts: InitProjectOptions): Promise<InitProjectResult> {
  const { cwd, args, model } = opts;
  const target = path.join(cwd, "AGENTS.md");
  const force = args.split(/\s+/).includes("force");
  if (!force && (await fileExists(target))) {
    return {
      message: `AGENTS.md already exists at ${target}. Use /init force to overwrite it.`,
      written: false,
      path: target,
      lines: 0,
      usedLlm: false,
    };
  }
  const facts = await scanProject(cwd);
  let usedLlm = false;
  let content: string;
  let note = "";
  if (model) {
    try {
      const polished = await polishWithModel(facts, model);
      if (polished) {
        content = polished.endsWith("\n") ? polished : `${polished}\n`;
        usedLlm = true;
      } else {
        content = renderAgentsMd(facts);
        note =
          " Model returned an empty draft; used the template instead — review and refine manually.";
      }
    } catch {
      content = renderAgentsMd(facts);
      note = " Model refinement failed; used the template instead — review and refine manually.";
    }
  } else {
    content = renderAgentsMd(facts);
    note = " No model available; used the template — review and refine manually.";
  }
  await fs.writeFile(target, content);
  const lines = content.split("\n").length;
  const how = usedLlm ? "generated with model refinement" : "generated from template";
  return {
    message: `Wrote ${target} (${lines} lines, ${how}).${note}`,
    written: true,
    path: target,
    lines,
    usedLlm,
  };
}
