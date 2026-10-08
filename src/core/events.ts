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

// Canonical total for a usage record: prompt + completion. Some providers
// report a totalTokens that additionally counts reasoning or other hidden
// classes, so summing the two billed classes keeps every aggregation
// (subagent folding, session totals, cost) on one basis. Falls back to the
// reported total when the per-class counts carry nothing (a total-only
// report), so that spend is not dropped either.
export function usageTotalTokens(usage: TokenUsage): number {
  const summed = usage.promptTokens + usage.completionTokens;
  return summed > 0 ? summed : usage.totalTokens;
}

// Serializable description of a stream failure, carried by the error event
// instead of a live Error: plain data survives JSON.stringify (the debug log
// writes JSONL; an Error serializes to "{}") and any future process
// boundary. Every property the retry policy (llm/retry.ts) classifies on is
// captured losslessly by toStreamErrorInfo where the error is produced.
export interface StreamErrorInfo {
  name: string;
  message: string;
  // HTTP status the endpoint answered with (AI_APICallError.statusCode).
  statusCode?: number;
  // The AI SDK's own retryability verdict (it marks 429/5xx retryable).
  isRetryable?: boolean;
  // Node-style errno attached to the error itself (the classic stack).
  code?: string;
  // Errno carried by error.cause — Node's fetch reports transport failures
  // as TypeError("fetch failed") with the real errno at cause.code.
  causeCode?: string;
  // Response headers (Retry-After hints ride here); string values only.
  responseHeaders?: Record<string, string>;
  // Raw response body — relays often put the real failure reason there while
  // the message stays generic.
  responseBody?: string;
}

// Flattens any thrown value into a serializable StreamErrorInfo. The single
// Error→info conversion point: called where an error event is produced
// (llm/stream.ts, agent/loop.ts) so everything downstream — retry
// classification, the UI, JSON print — works on plain data. Non-Error values
// keep the old wrapping behavior: new Error(String(value)).
export function toStreamErrorInfo(error: unknown): StreamErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  const info: StreamErrorInfo = { name: err.name, message: err.message };
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") info.statusCode = statusCode;
  if ((err as { isRetryable?: unknown }).isRetryable === true) info.isRetryable = true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") info.code = code;
  const cause = (err as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  if (typeof causeCode === "string") info.causeCode = causeCode;
  const headers = (err as { responseHeaders?: unknown }).responseHeaders;
  if (headers && typeof headers === "object") {
    const strings: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") strings[key] = value;
    }
    if (Object.keys(strings).length > 0) info.responseHeaders = strings;
  }
  const body = (err as { responseBody?: unknown }).responseBody;
  if (typeof body === "string" && body.length > 0) info.responseBody = body;
  return info;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  // `invalidArgs` marks a call whose streamed arguments failed the tool's
  // schema validation (weak models sometimes imitate elided-argument
  // placeholders in the history): the stream recovered it instead of dying
  // on a terminal error. The loop must NOT execute such a call — it
  // persists it and answers with the validation error so the model can
  // correct itself on the next step.
  | { type: "tool-call"; id: string; name: string; args: unknown; invalidArgs?: string }
  | { type: "tool-result"; id: string; name: string; content: string; isError?: boolean }
  // Coarse progress while a tool call's JSON arguments stream in (emitted at
  // 4KB boundaries): large write_file payloads can stream for a while, and a
  // byte counter beats a dead-looking spinner.
  | { type: "tool-call-progress"; name: string; bytes: number }
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
  | { type: "error"; error: StreamErrorInfo };
