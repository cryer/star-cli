import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { starHome } from "../../config/paths";
import type { CommandRegistry } from "./registry";

const NAME_PATTERN = /^[a-z0-9-]+$/;
const DESCRIPTION_PATTERN = /^<!--\s*description:\s*(.+?)\s*-->\s*$/;
const DEFAULT_DESCRIPTION = "Custom prompt command";

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  source: string;
}

function parseCommandFile(filePath: string, name: string): CustomCommand | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  let description = DEFAULT_DESCRIPTION;
  const first = lines[0] ?? "";
  const match = first.match(DESCRIPTION_PATTERN);
  if (match) {
    description = match[1] ?? DEFAULT_DESCRIPTION;
    lines.shift();
    if (lines[0] !== undefined && lines[0].trim() === "") lines.shift();
  }
  const template = lines.join("\n").trim();
  if (!template) return null;
  return { name, description, template, source: filePath };
}

function scanDir(dir: string, into: Map<string, CustomCommand>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -".md".length);
    if (!NAME_PATTERN.test(name)) continue;
    const parsed = parseCommandFile(path.join(dir, entry), name);
    if (parsed) into.set(name, parsed);
  }
}

export function loadCustomCommands(cwd: string, home: string = starHome()): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  scanDir(path.join(home, "commands"), byName);
  scanDir(path.join(cwd, ".star", "commands"), byName);
  return [...byName.values()];
}

export function registerCustomCommands(
  registry: CommandRegistry,
  cwd: string,
  home?: string,
): CustomCommand[] {
  const registered: CustomCommand[] = [];
  for (const command of loadCustomCommands(cwd, home)) {
    if (registry.get(command.name)) continue;
    registry.register({
      name: command.name,
      description: command.description,
      usage: `/${command.name} [args]`,
      category: "Custom",
      run(args, ctx) {
        const prompt = command.template.split("$ARGUMENTS").join(args);
        if (ctx.submitPrompt) {
          return ctx.submitPrompt(prompt);
        }
        ctx.addSystemMessage(`/${command.name}: this context cannot submit prompts to the model.`);
      },
    });
    registered.push(command);
  }
  return registered;
}
