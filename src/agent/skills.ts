import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { starHome } from "../config/paths";
import type { Tool, ToolResult } from "../tools/types";

export const SKILL_FILE = "SKILL.md";
export const SKILL_MAX_CHARS = 32 * 1024;

const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  // Directory holding the SKILL.md; supporting files referenced by the skill
  // are resolved relative to it.
  dir: string;
  scope: "project" | "user";
}

// Parses the YAML-ish frontmatter of a SKILL.md without a yaml dependency:
// only flat `key: value` pairs are recognized, anything else is ignored.
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv?.[1]) meta[kv[1]] = (kv[2] ?? "").trim();
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

interface CacheEntry {
  mtimeMs: number;
  skill: Skill | null;
}

const cache = new Map<string, CacheEntry>();

function parseSkillFile(filePath: string, dirName: string, scope: Skill["scope"]): Skill | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.skill;

  let skill: Skill | null = null;
  try {
    const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    const name = parsed?.meta.name || dirName;
    const description = parsed?.meta.description;
    if (parsed && NAME_PATTERN.test(name) && description) {
      skill = { name, description, filePath, dir: path.dirname(filePath), scope };
    }
  } catch {
    skill = null;
  }
  cache.set(filePath, { mtimeMs, skill });
  return skill;
}

function scanDir(base: string, scope: Skill["scope"], into: Map<string, Skill>): void {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (!NAME_PATTERN.test(entry)) continue;
    const parsed = parseSkillFile(path.join(base, entry, SKILL_FILE), entry, scope);
    if (parsed) into.set(parsed.name, parsed);
  }
}

// Discovers skills: user scope in <home>/skills/<name>/SKILL.md, project scope
// in <cwd>/.star/skills/<name>/SKILL.md. Project skills override user skills
// of the same name. Metadata is cached per file by mtime, so calling this on
// every turn only costs two directory scans plus a stat per candidate.
export function discoverSkills(cwd: string, home: string = starHome()): Skill[] {
  const byName = new Map<string, Skill>();
  scanDir(path.join(home, "skills"), "user", byName);
  scanDir(path.join(cwd, ".star", "skills"), "project", byName);
  return [...byName.values()];
}

// System-prompt block listing the available skills. The model loads a skill's
// full instructions on demand through the skill tool instead of paying the
// token cost upfront.
export function formatSkillsBlock(skills: Skill[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "# Available skills",
    "When the user's request matches one of these skills, call the skill tool with its name to load the full instructions before proceeding:",
    ...lines,
  ].join("\n");
}

// Reads the skill body (frontmatter stripped) for the skill tool result.
export function loadSkillBody(skill: Skill): string | null {
  let parsed: { meta: Record<string, string>; body: string } | null = null;
  try {
    parsed = parseFrontmatter(readFileSync(skill.filePath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed?.body) return null;
  if (parsed.body.length > SKILL_MAX_CHARS) {
    return `${parsed.body.slice(0, SKILL_MAX_CHARS)}\n\n[skill truncated to ${SKILL_MAX_CHARS} characters]`;
  }
  return parsed.body;
}

// The skill tool re-discovers skills on every call, so skills added
// mid-session are usable without a restart.
export function createSkillTool(deps: { cwd: string; home?: string }): Tool {
  return {
    name: "skill",
    description:
      "Load the full instructions of a skill by name. Available skills are listed in the system prompt when present; call this before starting work that matches one of them.",
    permission: "read",
    parameters: z.object({
      name: z.string().describe("Name of the skill to load, as listed in the system prompt."),
    }),
    async execute(args): Promise<ToolResult> {
      const skills = discoverSkills(deps.cwd, deps.home);
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "none";
        return {
          content: `Unknown skill: "${args.name}". Available skills: ${available}`,
          isError: true,
        };
      }
      const body = loadSkillBody(skill);
      if (!body) {
        return { content: `Skill "${skill.name}" is empty or unreadable.`, isError: true };
      }
      return {
        content: [
          `# Skill: ${skill.name}`,
          "",
          body,
          "",
          `Base directory for relative file references in this skill: ${skill.dir}`,
        ].join("\n"),
      };
    },
  };
}
