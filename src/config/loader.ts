import fs from "node:fs";
import { parse } from "smol-toml";
import { loadEnvFile } from "./env";
import { globalConfigPath, projectConfigPath } from "./paths";
import { type CliOverrides, ConfigSchema, type StarConfig } from "./schema";

const PartialConfigSchema = ConfigSchema.partial();

type PartialConfig = ReturnType<typeof PartialConfigSchema.parse>;

function parseTomlFile(content: string, filePath: string): PartialConfig {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse TOML in ${filePath}: ${message}`);
  }
  const result = PartialConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config in ${filePath}: ${result.error.message}`);
  }
  return result.data;
}

function mergeConfig(base: PartialConfig, override: PartialConfig): PartialConfig {
  return { ...base, ...override };
}

function applyOverrides(config: PartialConfig, overrides?: CliOverrides): PartialConfig {
  if (!overrides) return config;
  const merged = { ...config };
  if (overrides.model !== undefined) merged.defaultModel = overrides.model;
  if (overrides.permissionMode !== undefined) merged.permissionMode = overrides.permissionMode;
  return merged;
}

async function readTomlFile(filePath: string): Promise<PartialConfig> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseTomlFile(content, filePath);
}

function readTomlFileSync(filePath: string): PartialConfig {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  return parseTomlFile(content, filePath);
}

export async function loadConfig(cwd: string, overrides?: CliOverrides): Promise<StarConfig> {
  loadEnvFile();
  const global = await readTomlFile(globalConfigPath());
  const project = await readTomlFile(projectConfigPath(cwd));
  const merged = applyOverrides(mergeConfig(global, project), overrides);
  return ConfigSchema.parse(merged);
}

export function loadConfigSync(cwd: string, overrides?: CliOverrides): StarConfig {
  loadEnvFile();
  const global = readTomlFileSync(globalConfigPath());
  const project = readTomlFileSync(projectConfigPath(cwd));
  const merged = applyOverrides(mergeConfig(global, project), overrides);
  return ConfigSchema.parse(merged);
}
