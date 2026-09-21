import type { ModelConfig } from "../config/schema";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
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
export function computeCostUsd(usage: TokenUsage, model: ModelConfig | undefined): number | null {
  if (model?.promptPrice === undefined || model.completionPrice === undefined) {
    return null;
  }
  return (
    (usage.promptTokens * model.promptPrice + usage.completionTokens * model.completionPrice) /
    1_000_000
  );
}

export function estimateCost(
  usage: TokenUsage,
  modelName: string,
  model: ModelConfig | undefined,
): string {
  const cost = computeCostUsd(usage, model);
  if (cost === null || model === undefined) {
    return `Estimated cost: unknown (no price configured for ${modelName})`;
  }
  return `Estimated cost: $${formatDollars(cost)} (${model.name} @ $${model.promptPrice}/M prompt, $${model.completionPrice}/M completion)`;
}
