import { type LanguageModel, type ToolSet, streamText } from "ai";
import type { StreamEvent } from "../core/events";
import type { CoreMessage } from "../core/messages";

export interface StreamChatOptions {
  model: LanguageModel;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  maxTokens?: number;
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const result = streamText({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools as ToolSet | undefined,
    abortSignal: opts.abortSignal,
    maxTokens: opts.maxTokens,
  });
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        yield { type: "text-delta", text: part.textDelta };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          args: part.args,
        };
        break;
      case "finish":
        yield {
          type: "finish",
          finishReason: part.finishReason,
          usage: part.usage,
        };
        break;
      case "error":
        yield {
          type: "error",
          error: part.error instanceof Error ? part.error : new Error(String(part.error)),
        };
        break;
    }
  }
}
