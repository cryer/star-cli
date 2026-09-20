import type { StreamEvent, TokenUsage } from "../core/events";

export function eventToJsonLine(event: StreamEvent): string | null {
  switch (event.type) {
    case "finish":
      return null;
    case "error":
      return JSON.stringify({ type: "error", error: { message: event.error.message } });
    default:
      return JSON.stringify(event);
  }
}

export class UsageTracker {
  private requests = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;

  add(usage?: TokenUsage): void {
    if (!usage) return;
    this.requests += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
  }

  get totals(): TokenUsage & { requests: number } {
    return {
      requests: this.requests,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
    };
  }

  toJsonLine(): string | null {
    if (this.requests === 0) return null;
    return JSON.stringify({
      type: "usage",
      requests: this.requests,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
    });
  }
}
