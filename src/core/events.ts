export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; content: string; isError?: boolean }
  | { type: "finish"; finishReason: string; usage?: TokenUsage }
  // A model request failed (or came back empty) and is about to be retried;
  // `attempt`/`maxAttempts` are 1-based counts of the upcoming attempt.
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | { type: "error"; error: Error };
