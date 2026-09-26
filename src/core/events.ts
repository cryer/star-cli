export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Prompt tokens served from the provider cache, reported as a subset of
  // promptTokens (OpenAI / openai-compatible style).
  cachedPromptTokens?: number;
  // Cache-read tokens reported outside promptTokens (Anthropic style), so
  // they also count toward the effective prompt total.
  cacheReadInputTokens?: number;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; content: string; isError?: boolean }
  // `truncated` marks a stream that the idle watchdog ended gracefully while
  // it already had content — the reply may be cut off mid-thought.
  | { type: "finish"; finishReason: string; usage?: TokenUsage; truncated?: boolean }
  // A model request failed (or came back empty) and is about to be retried;
  // `attempt`/`maxAttempts` are 1-based counts of the upcoming attempt, and
  // `delayMs` is how long the loop waits before it (Retry-After hints or
  // jittered backoff).
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs?: number; reason: string }
  // Informational note worth surfacing in the UI (e.g. an auto-continue
  // nudge was injected because the model stopped with work announced).
  | { type: "notice"; message: string }
  | { type: "error"; error: Error };
