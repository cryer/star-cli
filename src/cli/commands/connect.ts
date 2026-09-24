import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { upsertEnvContent } from "../../config/env";
import { envFilePath, globalConfigPath } from "../../config/paths";
import type { ModelConfig, ProviderConfig } from "../../config/schema";

export type Protocol = ProviderConfig["protocol"];

export interface ProviderPreset {
  key: string;
  label: string;
  baseURL: string;
  protocol: Protocol;
  // example model id shown as the placeholder of the model prompt
  modelHint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    modelHint: "gpt-4o",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    baseURL: "https://api.anthropic.com",
    protocol: "anthropic",
    modelHint: "claude-sonnet-4-5",
  },
  {
    key: "moonshot",
    label: "Kimi (Moonshot)",
    baseURL: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    modelHint: "kimi-k2-0905-preview",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    protocol: "openai-compatible",
    modelHint: "deepseek-chat",
  },
];

export const PROTOCOLS: Protocol[] = ["openai-compatible", "anthropic", "openai-responses"];

export const PROTOCOL_DESCRIPTIONS: Record<Protocol, string> = {
  "openai-compatible": "POST /chat/completions — most providers and relays",
  anthropic: "Anthropic Messages API",
  "openai-responses": "OpenAI Responses API (relays exposing only /responses)",
};

// Context window written into new [[models]] blocks; edit after saving when
// the real limit differs.
export const CONNECT_DEFAULT_CONTEXT_TOKENS = 128_000;

export interface ConnectAnswers {
  providerName: string;
  protocol: Protocol;
  baseURL: string;
  apiKeyEnv: string;
  apiKey: string;
  modelName: string;
  modelId: string;
}

// Derives a config name from the baseURL host: "https://openrouter.ai/api/v1"
// → "openrouter", "https://api.openai.com/v1" → "openai". Falls back to
// "provider" when nothing usable can be extracted.
export function deriveProviderName(baseURL: string): string {
  let host = baseURL;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    host = baseURL.replace(/^[a-z]+:\/\//i, "").split(/[/:?#]/)[0] ?? baseURL;
  }
  const labels = host.toLowerCase().split(".");
  const skip = new Set(["www", "api"]);
  const meaningful = labels.filter((label) => label !== "" && !skip.has(label));
  const raw = meaningful[0] ?? "provider";
  const slug = raw
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "provider";
}

export function dedupeName(base: string, taken: string[]): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function apiKeyEnvFor(providerName: string): string {
  return `STAR_API_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// Masks a key for display: long keys show a short prefix and suffix, short
// ones are hidden completely. The full key must never appear in the UI.
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

// TOML basic strings share JSON string escaping.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildProviderTomlBlock(provider: ProviderConfig): string {
  return [
    "[[providers]]",
    `name = ${tomlString(provider.name)}`,
    "# wire format: openai-compatible | anthropic | openai-responses",
    `protocol = ${tomlString(provider.protocol)}`,
    `baseURL = ${tomlString(provider.baseURL)}`,
    "# environment variable holding the API key; the key itself lives in",
    "# ~/.star-cli/.env (written by /connect), never in this file",
    `apiKeyEnv = ${tomlString(provider.apiKeyEnv ?? "")}`,
    "# inline key instead of apiKeyEnv (not recommended):",
    '# apiKey = "sk-..."',
    "# extra HTTP headers sent to the provider:",
    '# headers = { "X-Title" = "star-cli" }',
    "",
    "",
  ].join("\n");
}

export function buildModelTomlBlock(model: ModelConfig): string {
  return [
    "[[models]]",
    `name = ${tomlString(model.name)}`,
    `provider = ${tomlString(model.provider)}`,
    `model = ${tomlString(model.model)}`,
    "# per-model context window in tokens — overrides the top-level",
    "# contextMaxTokens for compaction and the ctx % in the status bar",
    `contextMaxTokens = ${model.contextMaxTokens ?? CONNECT_DEFAULT_CONTEXT_TOKENS}`,
    "# pricing in USD per 1M tokens — set your provider's rates; BOTH",
    "# promptPrice and completionPrice are required together for the $",
    "# estimates in /cost and /usage (0 prices a token at $0)",
    `promptPrice = ${model.promptPrice ?? 0}`,
    `completionPrice = ${model.completionPrice ?? 0}`,
    "# cap on generated tokens per reply:",
    "# maxTokens = 8192",
    "",
    "",
  ].join("\n");
}

export interface ConnectResult {
  provider: ProviderConfig;
  model: ModelConfig;
  configPath: string;
  envPath: string;
}

// Persists a /connect result: the key goes into ~/.star-cli/.env (updated in
// place when the variable already exists, chmod 600 where the platform
// honors it) and is exported into this process so the model works without a
// restart; the [[providers]]/[[models]] blocks are appended to config.toml as
// text so existing content and comments survive.
export function saveConnection(
  answers: ConnectAnswers,
  configPath: string = globalConfigPath(),
  envPath: string = envFilePath(),
): ConnectResult {
  const provider: ProviderConfig = {
    name: answers.providerName,
    protocol: answers.protocol,
    baseURL: answers.baseURL,
    apiKeyEnv: answers.apiKeyEnv,
  };
  const model: ModelConfig = {
    name: answers.modelName,
    provider: answers.providerName,
    model: answers.modelId,
    contextMaxTokens: CONNECT_DEFAULT_CONTEXT_TOKENS,
    promptPrice: 0,
    completionPrice: 0,
  };

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  let envContent = "";
  try {
    envContent = fs.readFileSync(envPath, "utf8");
  } catch {
    envContent = "";
  }
  fs.writeFileSync(
    envPath,
    upsertEnvContent(envContent, provider.apiKeyEnv ?? "", answers.apiKey),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // chmod is a no-op on Windows; best effort only.
  }
  if (provider.apiKeyEnv) {
    process.env[provider.apiKeyEnv] = answers.apiKey;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf8");
  } catch {
    existing = "";
  }
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(
    configPath,
    existing + separator + buildProviderTomlBlock(provider) + buildModelTomlBlock(model),
    "utf8",
  );

  return { provider, model, configPath, envPath };
}

// Rewrites the top-level defaultModel line in place (other content and
// comments preserved); inserts the line at the top when missing.
export function setDefaultModelInToml(content: string, modelName: string): string {
  const line = `defaultModel = ${tomlString(modelName)}`;
  const lines = content.split("\n");
  let inTopLevel = true;
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    if (/^\s*\[/.test(current)) inTopLevel = false;
    if (inTopLevel && /^\s*defaultModel\s*=/.test(current)) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  return `${line}\n${content}`;
}

export function saveDefaultModel(modelName: string, configPath: string = globalConfigPath()): void {
  let content = "";
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    content = "";
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, setDefaultModelInToml(content, modelName), "utf8");
}

// Opens a file with the system default handler, fire-and-forget; failures
// are silent (the caller already shows the path).
export function openConfigFile(filePath: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", filePath]]
      : process.platform === "darwin"
        ? ["open", [filePath]]
        : ["xdg-open", [filePath]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no handler available — nothing to do
  }
}
