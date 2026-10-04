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

// Pick the model at startup. An explicit --model already sits in
// config.defaultModel (loader override), so it wins naturally; otherwise a
// resumed session's recorded model is restored when it still exists in the
// config. A stale recorded model falls back to the default with a notice.
export function resolveStartupModel(
  config: StarConfig,
  sessionModel?: string | null,
): { name: string | undefined; notice: string | null } {
  if (sessionModel) {
    if (config.models.some((m) => m.name === sessionModel)) {
      return { name: sessionModel, notice: null };
    }
    return {
      name: config.defaultModel,
      notice: `Session model "${sessionModel}" not found in config — using default model.`,
    };
  }
  return { name: config.defaultModel, notice: null };
}
