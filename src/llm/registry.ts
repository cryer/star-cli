import type { ModelConfig, StarConfig } from "../config/schema";

export function listModels(config: StarConfig): ModelConfig[] {
  return config.models;
}

export function resolveModelConfig(config: StarConfig, modelName?: string): ModelConfig {
  const name = modelName ?? config.defaultModel;
  const model = config.models.find((m) => m.name === name);
  if (!model) {
    const available = config.models.map((m) => m.name).join(", ") || "(none)";
    throw new Error(`Model "${name}" not found. Available models: ${available}`);
  }
  return model;
}
