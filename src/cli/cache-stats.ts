import type { TokenUsage } from "../core/events";

// Session prompt-cache totals backing the StatusBar "cache:" field.
// `promptTokens` is the cache-eligible prompt denominator: OpenAI-style
// providers report cache hits as a subset of promptTokens, while Anthropic
// reports cache reads on top of it, so those reads are added here as well.
export interface CacheTotals {
  cachedTokens: number;
  promptTokens: number;
}

export function cacheUsageReported(usage: TokenUsage): boolean {
  return usage.cachedPromptTokens != null || usage.cacheReadInputTokens != null;
}

export function addToCacheTotals(totals: CacheTotals, usage: TokenUsage): void {
  totals.cachedTokens += (usage.cachedPromptTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  totals.promptTokens += usage.promptTokens + (usage.cacheReadInputTokens ?? 0);
}

// Hit rate 0-100, or null when no cache-eligible prompt tokens accumulated.
export function cacheHitPercent(totals: CacheTotals): number | null {
  if (totals.promptTokens <= 0) return null;
  const rate = totals.cachedTokens / totals.promptTokens;
  return Math.round(Math.min(1, Math.max(0, rate)) * 100);
}
