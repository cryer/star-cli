import type { StreamEvent, TokenUsage } from "../core/events";

export function eventToJsonLine(event: StreamEvent): string | null {
  switch (event.type) {
    case "finish":
      return null;
    case "error":
      return JSON.stringify(event);
    default:
      return JSON.stringify(event);
  }
}

export class UsageTracker {
  private requests = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private cachedPromptTokens: number | undefined;
  private cacheReadInputTokens: number | undefined;

  add(usage?: TokenUsage): void {
    if (!usage) return;
    this.requests += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    if (usage.cachedPromptTokens !== undefined) {
      this.cachedPromptTokens = (this.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
    }
    if (usage.cacheReadInputTokens !== undefined) {
      this.cacheReadInputTokens = (this.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
    }
  }

  get totals(): TokenUsage & { requests: number } {
    return {
      requests: this.requests,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      ...(this.cachedPromptTokens !== undefined
        ? { cachedPromptTokens: this.cachedPromptTokens }
        : {}),
      ...(this.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: this.cacheReadInputTokens }
        : {}),
    };
  }

  toJsonLine(): string | null {
    if (this.requests === 0) return null;
    return JSON.stringify({ type: "usage", ...this.totals });
  }
}
