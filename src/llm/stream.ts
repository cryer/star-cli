import { type LanguageModel, type ToolSet, streamText } from "ai";
import type { StreamEvent } from "../core/events";
import type { CoreMessage } from "../core/messages";

export interface StreamChatOptions {
  model: LanguageModel;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  maxTokens?: number;
  // Idle watchdog: some relays deliver the final content but never send the
  // terminal chunks (or never close the socket). If no stream part arrives
  // within this window, the stream is ended gracefully with what we have.
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.abortSignal?.addEventListener("abort", onAbort);
  const result = streamText({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools as ToolSet | undefined,
    abortSignal: controller.signal,
    maxTokens: opts.maxTokens,
  });
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const iterator = result.fullStream[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), idleTimeoutMs);
      });
      const next = await Promise.race([iterator.next(), idle]);
      if (timer) clearTimeout(timer);
      if (next === null) {
        // Note: the AI SDK holds the model's finish part until the source
        // stream closes, so a relay that stops sending without closing can
        // only be detected by this watchdog.
        yield { type: "finish", finishReason: "idle-timeout", usage: undefined };
        return;
      }
      if (next.done) return;
      const part = next.value;
      switch (part.type) {
        case "text-delta":
          yield { type: "text-delta", text: part.textDelta };
          break;
        case "reasoning":
          yield { type: "reasoning", text: part.textDelta };
          break;
        case "tool-call":
          yield {
            type: "tool-call",
            id: part.toolCallId,
            name: part.toolName,
            args: part.args,
          };
          break;
        case "finish": {
          const finite = (n: number) => (Number.isFinite(n) ? n : 0);
          yield {
            type: "finish",
            finishReason: part.finishReason,
            usage: part.usage
              ? {
                  promptTokens: finite(part.usage.promptTokens),
                  completionTokens: finite(part.usage.completionTokens),
                  totalTokens: finite(part.usage.totalTokens),
                }
              : undefined,
          };
          return;
        }
        case "error":
          // A user-initiated abort surfacing as a stream error is not a failure.
          if (opts.abortSignal?.aborted) return;
          yield {
            type: "error",
            error: part.error instanceof Error ? part.error : new Error(String(part.error)),
          };
          break;
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    // Cancels the upstream request if it is still open (e.g. a relay that
    // sent its last byte but kept the connection alive).
    controller.abort();
  }
}
