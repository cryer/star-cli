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

async function addPermissionRule(kind: "allow" | "deny", rule: string): Promise<boolean> {
  const filePath = globalConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
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
  permissions[kind] = [...rules, rule];
  raw.permissions = permissions;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, stringify(raw), "utf8");
  return true;
}

export async function savePermissionMode(mode: string): Promise<void> {
  const filePath = globalConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    raw = parse(content) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  raw.permissionMode = mode;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, stringify(raw), "utf8");
}
