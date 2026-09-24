import { type LanguageModel, type ToolSet, streamText } from "ai";
import type { StreamEvent, TokenUsage } from "../core/events";
import type { CoreMessage } from "../core/messages";

export interface StreamChatOptions {
  model: LanguageModel;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  maxTokens?: number;
  // Idle watchdog: some relays deliver the final content but never send the
  // terminal chunks (or never close the socket). If no stream part arrives
  // within this window once streaming has started, the stream is ended
  // gracefully with what we have.
  idleTimeoutMs?: number;
  // Separate, longer allowance for the very first part: thinking models and
  // slow relays can take a while before producing anything, and a false
  // timeout here would kill a healthy request.
  firstPartTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_FIRST_PART_TIMEOUT_MS = 120_000;

const CACHE_READ_KEYS = ["cacheReadInputTokens", "cache_read_input_tokens"];
const CACHED_PROMPT_KEYS = ["cachedPromptTokens", "cached_prompt_tokens", "cachedTokens"];

// Pulls prompt-cache token counts out of a finish part's providerMetadata.
// Anthropic-style fields (cacheReadInputTokens) report cache reads on top of
// promptTokens; OpenAI-style fields (cachedPromptTokens) are a subset of it.
// Only finite numbers are accepted; anything else means "not provided".
export function extractCacheUsage(
  providerMetadata: unknown,
): Pick<TokenUsage, "cachedPromptTokens" | "cacheReadInputTokens"> {
  if (!providerMetadata || typeof providerMetadata !== "object") return {};
  for (const value of Object.values(providerMetadata)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of CACHE_READ_KEYS) {
      const n = record[key];
      if (typeof n === "number" && Number.isFinite(n)) return { cacheReadInputTokens: n };
    }
    for (const key of CACHED_PROMPT_KEYS) {
      const n = record[key];
      if (typeof n === "number" && Number.isFinite(n)) return { cachedPromptTokens: n };
    }
  }
  return {};
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.abortSignal?.addEventListener("abort", onAbort);
  // Abort listeners only fire on future aborts: mirror an abort that already
  // happened before this listener was registered (Esc landing while the loop
  // was still preparing the request), or the request would run on until the
  // idle watchdog despite having been cancelled.
  if (opts.abortSignal?.aborted) controller.abort();
  const result = streamText({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools as ToolSet | undefined,
    abortSignal: controller.signal,
    maxTokens: opts.maxTokens,
  });
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const firstPartTimeoutMs = opts.firstPartTimeoutMs ?? DEFAULT_FIRST_PART_TIMEOUT_MS;
  const iterator = result.fullStream[Symbol.asyncIterator]();
  let seenPart = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), seenPart ? idleTimeoutMs : firstPartTimeoutMs);
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
      seenPart = true;
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
          const cache = extractCacheUsage(
            part.providerMetadata ?? part.experimental_providerMetadata,
          );
          yield {
            type: "finish",
            finishReason: part.finishReason,
            usage: part.usage
              ? {
                  promptTokens: finite(part.usage.promptTokens),
                  completionTokens: finite(part.usage.completionTokens),
                  totalTokens: finite(part.usage.totalTokens),
                  ...cache,
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
