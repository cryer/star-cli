import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { globalConfigPath } from "./paths";

export async function addAllowRule(rule: string): Promise<boolean> {
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
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  if (allow.includes(rule)) return false;
  permissions.allow = [...allow, rule];
  raw.permissions = permissions;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, stringify(raw), "utf8");
  return true;
}
