import { type LanguageModel, type ToolSet, streamText } from "ai";
import type { StreamEvent, TokenUsage } from "../core/events";
import type { CoreMessage } from "../core/messages";
import { debugStreamLog } from "./debug";
import { summarizeStreamError } from "./retry";

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
    // Disable the SDK's own retries (ai@4 defaults to 2 internal attempts with
    // fixed backoff that ignores Retry-After and the abort signal, and
    // exhaustion throws an AI_RetryError stripped of status/headers/body) —
    // the retry policy in agent/loop.ts + llm/retry.ts owns the full budget
    // and needs the raw error to classify.
    maxRetries: 0,
    experimental_providerMetadata: {
      // Only the openai provider (our responses-protocol path) reads these;
      // other providers ignore unknown metadata. The SDK's responses provider
      // sends every tool with strict:true by default (strictSchemas), and
      // strict mode requires every schema property to be required — our
      // classic function-calling schemas use optional properties, which
      // relays then reject. store:false matches how codex and opencode talk
      // to relays (no server-side response storage).
      openai: { strictSchemas: false, store: false },
    },
  });
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const firstPartTimeoutMs = opts.firstPartTimeoutMs ?? DEFAULT_FIRST_PART_TIMEOUT_MS;
  const iterator = result.fullStream[Symbol.asyncIterator]();
  let seenPart = false;
  let deltas = 0;
  // Any visible content streamed (text, reasoning, or a tool call) — decides
  // whether an idle-watchdog cutoff marks the finish event as truncated.
  let hasContent = false;
  debugStreamLog("request", {
    messages: opts.messages.length,
    idleTimeoutMs,
    firstPartTimeoutMs,
  });
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), seenPart ? idleTimeoutMs : firstPartTimeoutMs);
      });
      let next: Awaited<ReturnType<typeof iterator.next>> | null;
      try {
        next = await Promise.race([iterator.next(), idle]);
      } catch (error) {
        debugStreamLog("stream-throw", {
          seenPart,
          deltas,
          error: error instanceof Error ? summarizeStreamError(error) : String(error),
        });
        throw error;
      } finally {
        // Clear in finally: when iterator.next() rejects, skipping this would
        // leave the watchdog timer pending for up to the full first-part
        // allowance.
        if (timer) clearTimeout(timer);
      }
      if (next === null) {
        // Note: the AI SDK holds the model's finish part until the source
        // stream closes, so a relay that stops sending without closing can
        // only be detected by this watchdog.
        debugStreamLog("idle-timeout", {
          seenPart,
          deltas,
          waitedMs: seenPart ? idleTimeoutMs : firstPartTimeoutMs,
        });
        yield {
          type: "finish",
          finishReason: "idle-timeout",
          usage: undefined,
          // Content already streamed means the reply may be cut off
          // mid-thought; the loop surfaces a notice for that.
          ...(hasContent ? { truncated: true } : {}),
        };
        return;
      }
      if (next.done) {
        debugStreamLog("end", { seenPart, deltas });
        return;
      }
      seenPart = true;
      const part = next.value;
      switch (part.type) {
        case "text-delta":
          deltas++;
          hasContent = true;
          yield { type: "text-delta", text: part.textDelta };
          break;
        case "reasoning":
          deltas++;
          hasContent = true;
          yield { type: "reasoning", text: part.textDelta };
          break;
        case "tool-call":
          hasContent = true;
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
          debugStreamLog("finish", {
            finishReason: part.finishReason,
            usage: part.usage,
            deltas,
          });
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
        case "error": {
          // A user-initiated abort surfacing as a stream error is not a failure.
          if (opts.abortSignal?.aborted) return;
          const error = part.error instanceof Error ? part.error : new Error(String(part.error));
          debugStreamLog("error-part", { seenPart, deltas, error: summarizeStreamError(error) });
          yield { type: "error", error };
          break;
        }
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    // Cancels the upstream request if it is still open (e.g. a relay that
    // sent its last byte but kept the connection alive).
    controller.abort();
  }
}
