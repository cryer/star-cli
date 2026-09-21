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

export function estimateCost(
  usage: TokenUsage,
  modelName: string,
  model: ModelConfig | undefined,
): string {
  if (model?.promptPrice === undefined || model.completionPrice === undefined) {
    return `Estimated cost: unknown (no price configured for ${modelName})`;
  }
  const cost =
    (usage.promptTokens * model.promptPrice + usage.completionTokens * model.completionPrice) /
    1_000_000;
  return `Estimated cost: $${formatDollars(cost)} (${model.name} @ $${model.promptPrice}/M prompt, $${model.completionPrice}/M completion)`;
}
