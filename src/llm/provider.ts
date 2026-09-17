import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderConfig, StarConfig } from "../config/schema";
import { resolveModelConfig } from "./registry";

function resolveApiKey(provider: ProviderConfig): string {
  const fromEnv = provider.apiKeyEnv
    ? process.env[provider.apiKeyEnv]
    : undefined;
  const apiKey = fromEnv ?? provider.apiKey;
  if (!apiKey) {
    const hint = provider.apiKeyEnv
      ? `set ${provider.apiKeyEnv} or configure apiKey`
      : "configure apiKey";
    throw new Error(`Missing API key for provider "${provider.name}": ${hint}`);
  }
  return apiKey;
}

export function createModel(
  config: StarConfig,
  modelName?: string,
): LanguageModel {
  const modelConfig = resolveModelConfig(config, modelName);
  const provider = config.providers.find(
    (p) => p.name === modelConfig.provider,
  );
  if (!provider) {
    const available =
      config.providers.map((p) => p.name).join(", ") || "(none)";
    throw new Error(
      `Provider "${modelConfig.provider}" for model "${modelConfig.name}" not found. Available providers: ${available}`,
    );
  }
  const apiKey = resolveApiKey(provider);
  switch (provider.protocol) {
    case "anthropic":
      return createAnthropic({
        baseURL: provider.baseURL,
        apiKey,
        headers: provider.headers,
      })(modelConfig.model);
    case "openai-compatible":
      return createOpenAICompatible({
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey,
        headers: provider.headers,
      })(modelConfig.model);
  }
}
