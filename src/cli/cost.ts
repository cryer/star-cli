import type { ModelConfig } from "../config/schema";
import { computeCostUsd } from "../core/cost";

export { computeCostUsd } from "../core/cost";

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

// User-facing token counts by magnitude: the raw number below 1K, otherwise
// K/M with two decimals (842 → "842", 532_100 → "532.10K", 6_740_000 →
// "6.74M"). Request counts and config values stay raw — this is for tokens.
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(2)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Compact token count for the status bar's ctx gauge: one decimal, a trailing
// ".0" dropped (60_700 → "60.7K", 200_000 → "200K", 1_000_000 → "1M").
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1000) return String(n);
  const thousands = n < 1_000_000;
  const scaled = thousands ? n / 1000 : n / 1_000_000;
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${thousands ? "K" : "M"}`;
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
