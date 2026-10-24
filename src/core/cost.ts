import type { ModelConfig } from "../config/schema";

export interface CostUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
}

export function computeCostUsd(usage: CostUsage, model: ModelConfig | undefined): number | null {
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
