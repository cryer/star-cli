import { type LanguageModel, type ToolSet, streamText } from "ai";
import { type StreamEvent, type TokenUsage, toStreamErrorInfo } from "../core/events";
import type { CoreMessage } from "../core/messages";
import { streamActivity } from "./activity";
import { debugStreamLog } from "./debug";
import type { ProviderMetadata } from "./provider";
import { summarizeStreamError } from "./retry";

export interface StreamChatOptions {
  model: LanguageModel;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  maxTokens?: number;
  // Per-model sampling temperature (config [[models]] temperature), resolved
  // by the caller; undefined falls through to the SDK default (ai@4: 0).
  temperature?: number;
  // Extra per-call provider metadata (e.g. reasoningEffort), keyed by provider
  // instance name. Merged into the request; the openai entry merges with the
  // strictSchemas/store defaults below instead of replacing them.
  providerMetadata?: ProviderMetadata;
  // Idle watchdog: some relays deliver the final content but never send the
  // terminal chunks (or never close the socket). If no stream part arrives
  // within this window once content has started streaming, the stream is
  // ended gracefully with what we have.
  idleTimeoutMs?: number;
  // Separate, longer allowance before the first CONTENT part: thinking
  // models and slow relays can sit silent for minutes after accepting the
  // request, and a false timeout here would kill a healthy request. Control
  // parts (response-metadata, tool-call-streaming-start, ...) do not count
  // as content — the responses protocol emits response-metadata the moment
  // the server sends response.created, long before any thinking output.
  firstPartTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_FIRST_PART_TIMEOUT_MS = 120_000;

// Parts that mark visible reply content. Only these demote the generous
// first-part allowance to the short idle one. Control/metadata parts
// (response-metadata, tool-call-streaming-start, reasoning-signature, source,
// file) and reasoning only prove the connection is alive: reasoning models
// (kimi with high effort) pause mid-thinking with zero bytes for tens of
// seconds, so demoting on a thinking delta kills the stream as a spurious
// idle-timeout — and since the reasoning was never persisted, the retry
// resends the identical request and hits the same deterministic stall.
const CONTENT_PART_TYPES = new Set(["text-delta", "tool-call", "tool-call-delta"]);

// Absolute cap on how long byte-level keepalives (SSE heartbeat comments the
// SDK swallows) may extend a stream that produces no parts at all — without
// it a heartbeat-only zombie connection could hang a turn forever.
const MAX_KEEPALIVE_SILENCE_MS = 10 * 60_000;

const CACHE_READ_KEYS = ["cacheReadInputTokens", "cache_read_input_tokens"];
const CACHED_PROMPT_KEYS = ["cachedPromptTokens", "cached_prompt_tokens", "cachedTokens"];

// Anthropic prompt caching: a cache_control block marks "everything from the
// request start up to this block" as a cached prefix. The agent loop resends
// the full history every step, so two breakpoints — the leading system
// message (covers the tool definitions and the static prompt prefix) and the
// last message (the whole history so far) — turn most of every resend into
// ~0.1x-billed cache reads. Other protocols do their own server-side caching
// and never see this (provider metadata is keyed by provider name).
export function withAnthropicCacheBreakpoints(
  model: LanguageModel,
  messages: CoreMessage[],
): CoreMessage[] {
  if (!model.provider.startsWith("anthropic")) return messages;
  const mark = (message: CoreMessage): CoreMessage => ({
    ...message,
    experimental_providerMetadata: {
      ...message.experimental_providerMetadata,
      anthropic: {
        ...message.experimental_providerMetadata?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    },
  });
  const result = messages.slice();
  if (result[0]?.role === "system") result[0] = mark(result[0]);
  const last = result.length - 1;
  if (last > 0 && result[last]) result[last] = mark(result[last] as CoreMessage);
  return result;
}

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
  const { openai: openaiMetadata, ...otherMetadata } = opts.providerMetadata ?? {};
  const result = streamText({
    model: opts.model,
    messages: withAnthropicCacheBreakpoints(opts.model, opts.messages),
    tools: opts.tools as ToolSet | undefined,
    abortSignal: controller.signal,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    // Disable the SDK's own retries (ai@4 defaults to 2 internal attempts with
    // fixed backoff that ignores Retry-After and the abort signal, and
    // exhaustion throws an AI_RetryError stripped of status/headers/body) —
    // the retry policy in agent/loop.ts + llm/retry.ts owns the full budget
    // and needs the raw error to classify.
    maxRetries: 0,
    // Pass tool-call argument deltas through (instead of buffering until the
    // complete call) so large write_file payloads report receive progress.
    toolCallStreaming: true,
    experimental_providerMetadata: {
      // Only the openai provider (our responses-protocol path) reads these;
      // other providers ignore unknown metadata. The SDK's responses provider
      // sends every tool with strict:true by default (strictSchemas), and
      // strict mode requires every schema property to be required — our
      // classic function-calling schemas use optional properties, which
      // relays then reject. store:false matches how codex and opencode talk
      // to relays (no server-side response storage).
      ...otherMetadata,
      openai: { strictSchemas: false, store: false, ...openaiMetadata },
    },
  });
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const firstPartTimeoutMs = opts.firstPartTimeoutMs ?? DEFAULT_FIRST_PART_TIMEOUT_MS;
  const iterator = result.fullStream[Symbol.asyncIterator]();
  // True once a CONTENT part arrived — controls which watchdog window
  // applies. Control and reasoning parts never set it (see above).
  let seenContent = false;
  let deltas = 0;
  // Any visible reply content streamed (text or a completed tool call) —
  // decides whether an idle-watchdog cutoff marks the finish event as
  // truncated. Reasoning deliberately does not count: it is display-only and
  // never persisted, so a reasoning-only cutoff loses nothing the user saw —
  // flagging it "truncated" would show a scary notice for what is really a
  // silent-stall retry.
  let hasContent = false;
  // Accumulated tool-call argument sizes, for coarse progress events while a
  // large payload (write_file content) streams in.
  const argsProgress = new Map<string, { name: string; chars: number; nextMark: number }>();
  // Last time ANY part arrived; the keepalive extension is bounded against
  // this, not against the last byte (bytes without parts can flow forever).
  let lastPartAt = Date.now();
  debugStreamLog("request", {
    messages: opts.messages.length,
    idleTimeoutMs,
    firstPartTimeoutMs,
  });
  try {
    // At most one in-flight read, reused across watchdog wake-ups: fullStream
    // wraps a ReadableStreamDefaultReader whose pending reads queue FIFO and
    // each consume a DIFFERENT chunk, so a next() abandoned when the watchdog
    // wins the race would silently eat the part that eventually settles it.
    let pending: ReturnType<typeof iterator.next> | undefined;
    for (;;) {
      pending ??= iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const windowMs = seenContent ? idleTimeoutMs : firstPartTimeoutMs;
      const idle = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), windowMs);
      });
      let next: Awaited<ReturnType<typeof iterator.next>> | null;
      try {
        next = await Promise.race([pending, idle]);
      } catch (error) {
        debugStreamLog("stream-throw", {
          seenContent,
          deltas,
          error: error instanceof Error ? summarizeStreamError(error) : String(error),
        });
        throw error;
      } finally {
        // Clear in finally: when the read rejects, skipping this would leave
        // the watchdog timer pending for up to the full first-part allowance.
        if (timer) clearTimeout(timer);
      }
      // A settled read is consumed below; only a watchdog timeout leaves the
      // pending read in flight for the next race.
      if (next !== null) pending = undefined;
      if (next === null) {
        // Byte-level liveness check before cutting: relays fronting slow
        // upstreams often send SSE heartbeat comments while buffering, and
        // the SDK swallows them, so at the part level the stream looks dead
        // while bytes are still flowing. As long as raw chunks keep
        // arriving, keep waiting — bounded by MAX_KEEPALIVE_SILENCE_MS of
        // total part silence so a heartbeat-only zombie cannot hang a turn.
        const activity = streamActivity(controller.signal);
        const silentForMs = Date.now() - lastPartAt;
        const lastChunkAgoMs = activity ? Date.now() - activity.lastChunkAt : undefined;
        if (
          lastChunkAgoMs !== undefined &&
          lastChunkAgoMs < windowMs &&
          silentForMs < MAX_KEEPALIVE_SILENCE_MS
        ) {
          debugStreamLog("keepalive", { seenContent, deltas, lastChunkAgoMs, silentForMs });
          continue;
        }
        // Note: the AI SDK holds the model's finish part until the source
        // stream closes, so a relay that stops sending without closing can
        // only be detected by this watchdog.
        debugStreamLog("idle-timeout", {
          seenContent,
          deltas,
          waitedMs: windowMs,
          lastChunkAgoMs,
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
        debugStreamLog("end", { seenContent, deltas });
        return;
      }
      const part = next.value;
      lastPartAt = Date.now();
      if (CONTENT_PART_TYPES.has(part.type)) seenContent = true;
      switch (part.type) {
        case "text-delta":
          deltas++;
          hasContent = true;
          yield { type: "text-delta", text: part.textDelta };
          break;
        case "reasoning":
          deltas++;
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
        case "tool-call-streaming-start": {
          argsProgress.set(part.toolCallId, {
            name: part.toolName,
            chars: 0,
            nextMark: 4096,
          });
          break;
        }
        case "tool-call-delta": {
          const progress = argsProgress.get(part.toolCallId) ?? {
            name: part.toolName,
            chars: 0,
            nextMark: 4096,
          };
          progress.chars += part.argsTextDelta.length;
          argsProgress.set(part.toolCallId, progress);
          if (progress.chars >= progress.nextMark) {
            progress.nextMark *= 2;
            yield { type: "tool-call-progress", name: progress.name, bytes: progress.chars };
          }
          break;
        }
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
          // Flatten to serializable info here — the single Error→info
          // conversion point — so the event can cross JSONL logs and process
          // boundaries without losing the properties retry classifies on.
          const error = toStreamErrorInfo(part.error);
          debugStreamLog("error-part", { seenContent, deltas, error: summarizeStreamError(error) });
          // Errors are terminal: iterating past one would merge trailing
          // parts into a turn already flagged failed.
          yield { type: "error", error };
          return;
        }
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    // Release the stream when exiting mid-flight (idle cut, terminal error):
    // ai@4's iterator has no return(), so the abort is what actually cancels
    // the upstream request and settles any pending read — the last race still
    // observes that read, so it cannot reject unhandled.
    await iterator.return?.();
    controller.abort();
  }
}
