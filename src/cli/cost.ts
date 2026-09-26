import type { ModelConfig } from "../config/schema";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  // Prompt tokens served from the provider cache, a subset of promptTokens
  // (OpenAI / openai-compatible style).
  cachedPromptTokens?: number;
  // Cache-read tokens reported on top of promptTokens (Anthropic style).
  cacheReadInputTokens?: number;
}

export function formatDollars(cost: number): string {
  let s = cost.toFixed(4).replace(/0+$/, "");
  if (s.endsWith(".")) {
    s += "00";
  } else if (s.split(".")[1]?.length === 1) {
    s += "0";
  }
  return s;
}

// Numeric session cost in USD; null when the model has no pricing configured.
// Cache pricing: OpenAI-style cached tokens are a subset of promptTokens, so
// the uncached rest bills at promptPrice and the cached share at
// cacheReadPrice (full promptPrice when no cache price is configured);
// Anthropic-style cache reads come on top of promptTokens and bill at
// cacheReadPrice only (unconfigured = unbilled, as before).
export function computeCostUsd(usage: TokenUsage, model: ModelConfig | undefined): number | null {
  if (model?.promptPrice === undefined || model.completionPrice === undefined) {
    return null;
  }
  const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), usage.promptTokens);
  const promptUsd =
    (usage.promptTokens - cached) * model.promptPrice +
    cached * (model.cacheReadPrice ?? model.promptPrice) +
    (usage.cacheReadInputTokens ?? 0) * (model.cacheReadPrice ?? 0);
  return (promptUsd + usage.completionTokens * model.completionPrice) / 1_000_000;
}

export function estimateCost(
  usage: TokenUsage,
  modelName: string,
  model: ModelConfig | undefined,
): string {
  const cost = computeCostUsd(usage, model);
  if (cost === null) {
    if (model !== undefined) {
      const missing = [
        model.promptPrice === undefined ? "promptPrice" : null,
        model.completionPrice === undefined ? "completionPrice" : null,
      ].filter((f) => f !== null);
      if (missing.length === 1) {
        return `Estimated cost: unknown (${model.name} is missing ${missing[0]} — both prices are needed)`;
      }
    }
    return `Estimated cost: unknown (no price configured for ${modelName})`;
  }
  const cachePrice =
    model?.cacheReadPrice !== undefined ? `, $${model.cacheReadPrice}/M cache read` : "";
  return `Estimated cost: $${formatDollars(cost)} (${model?.name} @ $${model?.promptPrice}/M prompt, $${model?.completionPrice}/M completion${cachePrice})`;
}
