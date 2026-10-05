import fs from "node:fs";
import { parse } from "smol-toml";
import { registerSensitivePatterns } from "../core/sensitive";
import { setWebFetchAllowPrivateHosts } from "../tools/web/fetch";
import { loadEnvFile } from "./env";
import { globalConfigPath, projectConfigPath } from "./paths";
import { type CliOverrides, ConfigSchema, type ModelConfig, type StarConfig } from "./schema";

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

// Keys a project-level .star/config.toml may set. Anything else (providers,
// permissionMode, permissions, hooks, ...) stays global-only: a checked-out
// repo must not be able to plant shell hooks, force yolo mode, or redirect
// provider traffic to a key-harvesting endpoint.
const PROJECT_ALLOWED_KEYS = new Set([
  "defaultModel",
  "models",
  "maxSteps",
  "contextMaxTokens",
  "compactThresholdTokens",
  "streamIdleTimeoutSec",
  "streamFirstChunkTimeoutSec",
  "streamMaxRetries",
  "maxAutoContinues",
  "contextCompaction",
  "sessionBudgetUsd",
  "notifyBell",
  "notifyBellThresholdSec",
  "doomLoopThreshold",
  "gitSnapshots",
]);

// Safe ranges for the project-provided streaming knobs: a repo must not set
// pathological values (sub-second idle timeouts, thousands of retries).
const PROJECT_STREAM_RANGES = {
  streamIdleTimeoutSec: { min: 5, max: 120 },
  streamFirstChunkTimeoutSec: { min: 30, max: 900 },
  streamMaxRetries: { min: 0, max: 10 },
} as const;

// 0 disables these protections, so a project may only tighten them, never
// turn them off (handled at merge time via min()).
const PROJECT_PROTECTIVE_MIN_KEYS = new Set(["maxSteps", "doomLoopThreshold"]);

function warnProject(filePath: string, message: string): void {
  process.stderr.write(`[star] ${message} in ${filePath}\n`);
}

// Price fields are stripped from project models: a repo defining $0 prices
// would silently zero out /cost and defeat sessionBudgetUsd.
function stripModelPrices(models: ModelConfig[], filePath: string): ModelConfig[] {
  let stripped = false;
  const out = models.map((model) => {
    const { promptPrice, completionPrice, cacheReadPrice, ...rest } = model;
    if (
      promptPrice !== undefined ||
      completionPrice !== undefined ||
      cacheReadPrice !== undefined
    ) {
      stripped = true;
    }
    return rest;
  });
  if (stripped) {
    warnProject(filePath, "ignoring price fields in project [[models]]: pricing stays global-only");
  }
  return out;
}

function sanitizeProjectConfig(project: PartialConfig, filePath: string): PartialConfig {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (value === undefined) continue;
    if (!PROJECT_ALLOWED_KEYS.has(key)) {
      process.stderr.write(
        `[star] ignoring "${key}" in ${filePath}: project config cannot set this key\n`,
      );
      continue;
    }
    if (key === "gitSnapshots" && value === false) {
      // Snapshot tracking protects /undo and /redo; a repo may enable but
      // never disable it.
      warnProject(
        filePath,
        'ignoring "gitSnapshots = false": project config cannot disable this protection',
      );
      continue;
    }
    if (PROJECT_PROTECTIVE_MIN_KEYS.has(key) && value === 0) {
      warnProject(filePath, `ignoring "${key} = 0": project config cannot disable this protection`);
      continue;
    }
    const range = PROJECT_STREAM_RANGES[key as keyof typeof PROJECT_STREAM_RANGES];
    if (range && typeof value === "number") {
      const clamped = Math.min(range.max, Math.max(range.min, value));
      if (clamped !== value) {
        warnProject(
          filePath,
          `clamping "${key}" from ${value} to ${clamped}: project config is limited to ${range.min}–${range.max}`,
        );
      }
      sanitized[key] = clamped;
      continue;
    }
    if (key === "models" && Array.isArray(value)) {
      sanitized[key] = stripModelPrices(value as ModelConfig[], filePath);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized as PartialConfig;
}

// Project [[models]] merge with the global table by name: a project entry
// replaces the same-named global entry, every other global entry survives.
// (Shallow-spreading the array would let a repo silently swap the user's
// whole model table — and orphan a global defaultModel pointing into it.)
function mergeModelsByName(
  globalModels: ModelConfig[],
  projectModels: ModelConfig[],
): ModelConfig[] {
  const projectByName = new Map(projectModels.map((model) => [model.name, model]));
  const merged = globalModels.map((model) => projectByName.get(model.name) ?? model);
  const globalNames = new Set(globalModels.map((model) => model.name));
  for (const model of projectModels) {
    if (!globalNames.has(model.name)) merged.push(model);
  }
  return merged;
}

// 0 disables these protections (unlimited), so normalize it to +∞ before the
// min: a project must be able to tighten a globally-disabled guard (global
// maxSteps = 0, project 5 → 5), never to relax one.
function protectiveMin(a: number, b: number): number {
  const result = Math.min(
    a === 0 ? Number.POSITIVE_INFINITY : a,
    b === 0 ? Number.POSITIVE_INFINITY : b,
  );
  return result === Number.POSITIVE_INFINITY ? 0 : result;
}

// Project values merge protectively: a repo can tighten safeguards but never
// relax them. Budgets take the lower bound; guard thresholds take the lower
// bound too (a project-side 0 = disabled was already filtered out above, and
// a global 0 normalizes to +∞ via protectiveMin).
function mergeProjectConfig(
  global: PartialConfig,
  project: PartialConfig,
  projectPath: string,
): PartialConfig {
  const merged: PartialConfig = { ...global, ...project };
  if (project.models !== undefined) {
    merged.models = mergeModelsByName(global.models ?? [], project.models);
    warnProject(projectPath, `project config overrides ${project.models.length} model(s)`);
  }
  if (project.sessionBudgetUsd !== undefined && global.sessionBudgetUsd !== undefined) {
    merged.sessionBudgetUsd = Math.min(global.sessionBudgetUsd, project.sessionBudgetUsd);
  }
  if (project.maxSteps !== undefined) {
    merged.maxSteps = protectiveMin(global.maxSteps ?? 100, project.maxSteps);
  }
  if (project.doomLoopThreshold !== undefined) {
    merged.doomLoopThreshold = protectiveMin(
      global.doomLoopThreshold ?? 3,
      project.doomLoopThreshold,
    );
  }
  return merged;
}

// Plaintext keys still work, but config.toml is world-readable by default on
// some setups and gets committed by accident — point users at apiKeyEnv.
function warnPlaintextApiKey(config: PartialConfig): void {
  const offenders: string[] = [];
  for (const provider of config.providers ?? []) {
    if (provider.apiKey !== undefined) offenders.push(`provider "${provider.name}"`);
  }
  for (const model of config.models ?? []) {
    if ("apiKey" in model && model.apiKey !== undefined) offenders.push(`model "${model.name}"`);
  }
  if (offenders.length === 0) return;
  process.stderr.write(
    `[star] plaintext apiKey in config (${offenders.join(", ")}) is deprecated: store keys in ~/.star-cli/.env and reference them with apiKeyEnv instead\n`,
  );
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
  const projectPath = projectConfigPath(cwd);
  const project = sanitizeProjectConfig(await readTomlFile(projectPath), projectPath);
  const merged = applyOverrides(mergeProjectConfig(global, project, projectPath), overrides);
  warnPlaintextApiKey(merged);
  return wireRuntimeSettings(ConfigSchema.parse(merged));
}

export function loadConfigSync(cwd: string, overrides?: CliOverrides): StarConfig {
  loadEnvFile();
  const global = readTomlFileSync(globalConfigPath());
  const projectPath = projectConfigPath(cwd);
  const project = sanitizeProjectConfig(readTomlFileSync(projectPath), projectPath);
  const merged = applyOverrides(mergeProjectConfig(global, project, projectPath), overrides);
  warnPlaintextApiKey(merged);
  return wireRuntimeSettings(ConfigSchema.parse(merged));
}

// Pushes config-driven security settings into their runtime consumers. The
// merged permissions table is global-only at this point (the project sandbox
// dropped any project-side [permissions]), so these can never be planted by
// a checked-out repo.
function wireRuntimeSettings(config: StarConfig): StarConfig {
  registerSensitivePatterns(config.permissions.sensitive);
  setWebFetchAllowPrivateHosts(config.webFetchAllowPrivateHosts);
  return config;
}
