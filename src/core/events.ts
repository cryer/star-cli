export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; content: string; isError?: boolean }
  | { type: "finish"; finishReason: string; usage?: TokenUsage }
  | { type: "error"; error: Error };
