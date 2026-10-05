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
  try {
    // config.toml may hold plaintext apiKeys — keep it owner-only (0600).
    // Best-effort: chmod is effectively a no-op on Windows.
    await fs.promises.chmod(filePath, 0o600);
  } catch {}
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

// Unquotes a TOML basic ("...") or literal ('...') string; returns null for
// anything else (the value comparison then simply never matches).
function unquoteTomlString(raw: string): string | null {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

// Text-level upsert of reasoningEffort into the [[models]] block whose name
// matches, so comments and sibling keys survive: the key line is replaced in
// place (trailing comment kept), removed when effort is undefined, inserted
// after the model/name line when missing. Returns null when no block declares
// this model — the caller then applies the change for the session only
// instead of appending a fragment block that would fail schema validation.
export function setReasoningEffortInToml(
  content: string,
  modelName: string,
  effort: string | undefined,
): string | null {
  const lines = content.split("\n");
  const header = /^\s*\[\[\s*models\s*\]\]\s*(?:#.*)?$/;
  const anyHeader = /^\s*\[/;
  const nameLine = /^\s*name\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/;
  for (let start = 0; start < lines.length; start++) {
    if (!header.test(lines[start] ?? "")) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (anyHeader.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    let nameIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const match = nameLine.exec(lines[i] ?? "");
      if (match?.[1] && unquoteTomlString(match[1]) === modelName) {
        nameIndex = i;
        break;
      }
    }
    if (nameIndex === -1) continue;
    const keyLine = /^\s*reasoningEffort\s*=/;
    for (let i = start + 1; i < end; i++) {
      if (!keyLine.test(lines[i] ?? "")) continue;
      if (effort === undefined) {
        lines.splice(i, 1);
      } else {
        const comment = /\s+#.*$/.exec(lines[i] ?? "");
        lines[i] = `reasoningEffort = ${tomlString(effort)}${comment?.[0] ?? ""}`;
      }
      return lines.join("\n");
    }
    if (effort === undefined) return content;
    let insertAt = nameIndex + 1;
    for (let i = start + 1; i < end; i++) {
      if (/^\s*model\s*=/.test(lines[i] ?? "")) {
        insertAt = i + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, `reasoningEffort = ${tomlString(effort)}`);
    return lines.join("\n");
  }
  return null;
}

// Persists a model's reasoningEffort to the global config. Returns false when
// the file declares no [[models]] block for it (e.g. the model only exists in
// a project config) — nothing is written then.
export async function saveReasoningEffort(
  modelName: string,
  effort: string | undefined,
): Promise<boolean> {
  const filePath = globalConfigPath();
  let content = "";
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = setReasoningEffortInToml(content, modelName, effort);
  if (updated === null) return false;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, updated);
  return true;
}
