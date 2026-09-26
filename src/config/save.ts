import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { globalConfigPath } from "./paths";

export async function addAllowRule(rule: string): Promise<boolean> {
  return addPermissionRule("allow", rule);
}

export async function addDenyRule(rule: string): Promise<boolean> {
  return addPermissionRule("deny", rule);
}

// TOML basic strings share JSON string escaping.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, content, "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

// Text-level upsert of a rule list into the [permissions] table so comments
// and unrelated formatting survive: the key line is replaced in place when it
// is a complete inline array, inserted right after the table header when the
// key is missing, and the whole table is appended when absent. Returns null
// when the file's formatting defeats line-level surgery (exotic table header,
// multi-line array) and the caller must regenerate instead.
function upsertPermissionRuleText(
  content: string,
  kind: "allow" | "deny",
  rules: string[],
  hadPermissionsTable: boolean,
): string | null {
  const newLine = `${kind} = [${rules.map(tomlString).join(", ")}]`;
  const lines = content.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^\s*\[/.test(line)) continue;
    if (sectionStart === -1) {
      if (/^\s*\[\s*permissions\s*\]\s*(?:#.*)?$/.test(line)) sectionStart = i;
    } else {
      sectionEnd = i;
      break;
    }
  }
  if (sectionStart === -1) {
    if (hadPermissionsTable) return null;
    const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}[permissions]\n${newLine}\n`;
  }
  const inlineArray = new RegExp(`^(\\s*)${kind}\\s*=\\s*\\[.*\\](\\s*(?:#.*)?)$`);
  const anyKey = new RegExp(`^\\s*${kind}\\s*=`);
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const line = lines[i] ?? "";
    const match = inlineArray.exec(line);
    if (match) {
      lines[i] = `${match[1]}${newLine}${match[2]}`;
      return lines.join("\n");
    }
    if (anyKey.test(line)) return null;
  }
  lines.splice(sectionStart + 1, 0, newLine);
  return lines.join("\n");
}

async function addPermissionRule(kind: "allow" | "deny", rule: string): Promise<boolean> {
  const filePath = globalConfigPath();
  let content = "";
  let raw: Record<string, unknown> = {};
  try {
    content = await fs.promises.readFile(filePath, "utf8");
    raw = parse(content) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const permissions =
    typeof raw.permissions === "object" && raw.permissions !== null
      ? (raw.permissions as Record<string, unknown>)
      : {};
  const rules = Array.isArray(permissions[kind]) ? (permissions[kind] as string[]) : [];
  if (rules.includes(rule)) return false;
  const nextRules = [...rules, rule];
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const updated = upsertPermissionRuleText(content, kind, nextRules, raw.permissions !== undefined);
  if (updated !== null) {
    await writeFileAtomic(filePath, updated);
    return true;
  }
  permissions[kind] = nextRules;
  raw.permissions = permissions;
  await writeFileAtomic(filePath, stringify(raw));
  return true;
}

// Top-level keys live before the first [table] header: replace the key line
// in place when present (comments and unrelated formatting survive), insert
// right before the first table otherwise.
function upsertTopLevelKeyText(content: string, key: string, value: string): string {
  const newLine = `${key} = ${tomlString(value)}`;
  if (content.trim() === "") return `${newLine}\n`;
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyLine = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < end; i++) {
    const line = lines[i] ?? "";
    if (keyLine.test(line)) {
      const comment = /\s+#.*$/.exec(line);
      lines[i] = `${newLine}${comment?.[0] ?? ""}`;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, newLine);
  return lines.join("\n");
}

export async function savePermissionMode(mode: string): Promise<void> {
  const filePath = globalConfigPath();
  let content = "";
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, upsertTopLevelKeyText(content, "permissionMode", mode));
}
