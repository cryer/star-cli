// Retry classification and backoff for model requests, modeled on opencode's
// SessionRetry (sst/opencode, packages/opencode/src/session/retry.ts). Relays
// and gateways report transient failures inconsistently — a Cloudflare HTML
// 403, a 400 whose body says "provider returned error", a 200 stream that
// dies mid-way — so classification looks past the status code at the error
// message and response body, and the wait between attempts honors Retry-After
// headers with jittered exponential backoff as the fallback.
import type { StreamErrorInfo } from "../core/events";
import { responseBodyOf } from "../core/http-error";

// Client/validation failures will fail again identically, so only transient
// conditions merit another attempt. SDK validation errors never retry —
// TypeValidation/JSONParse mean the relay answered with a malformed payload,
// which a resend would burn the whole retry budget on.
const NON_RETRYABLE_ERROR_NAMES = new Set([
  "AI_NoSuchToolError",
  "AI_InvalidToolArgumentsError",
  "AI_InvalidPromptError",
  "AI_NoSuchModelError",
  "AI_LoadAPIKeyError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  /\b(408|425|429|500|502|503|504|520|521|522|523|524|529)\b/,
  /rate.?limit|too many requests|rate increased/i,
  /overloaded|service.?unavailable|internal (server )?error|server error|provider returned error|bad gateway|gateway timeout/i,
  /terminated|fetch failed|failed to fetch|network.?error|upstream connect|connection (?:error|refused|lost|reset)|socket (?:hang up|connection)|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout|epipe|ehostunreach|enetunreach/i,
  /\b(?:request|response|connection|network|stream|read|headers?|body) (?:timeout|timed out|time out)\b/i,
  /resource.?exhausted|try (?:your request )?again|at capacity/i,
];

// Deterministic client failures resend identically forever, so these 4xx
// codes fail fast even when the message or body sounds transient — "server
// error" text on a relay's error page must not burn the retry budget.
const NON_RETRYABLE_4XX = new Set([400, 401, 403, 404, 413, 422]);

// Network-stack errnos worth a resend: the connection died before or during
// the response, so a fresh attempt takes a different path.
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED",
]);

// Without an HTTP status the only honest retry signal is a network-family
// failure: Node's fetch reports those as TypeError("fetch failed") (usually
// with the errno on error.cause.code, flattened to causeCode by
// toStreamErrorInfo), and the classic stack attaches the errno to the error
// itself. Anything else statusless — above all a TypeError from a code bug —
// fails deterministically and must fail fast instead of resending the whole
// history five times.
function isNetworkFailure(error: StreamErrorInfo): boolean {
  for (const code of [error.code, error.causeCode]) {
    if (code && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))) return true;
  }
  return error.name === "TypeError" && /fetch failed|failed to fetch|network/i.test(error.message);
}

function matchesRetryablePattern(text: string | undefined): boolean {
  return typeof text === "string" && RETRYABLE_MESSAGE_PATTERNS.some((p) => p.test(text));
}

export function isRetryableStreamError(error: StreamErrorInfo): boolean {
  if (NON_RETRYABLE_ERROR_NAMES.has(error.name)) return false;
  // The SDK's own classification (it marks 429/5xx API call errors retryable).
  if (error.isRetryable === true) return true;
  const status = error.statusCode;
  if (status !== undefined) {
    // 501 Not Implemented is excluded from the 5xx blanket: the endpoint
    // cannot serve this request shape at all, so it falls through to the
    // message/body check like any other deterministic status.
    if (status === 408 || status === 429 || (status >= 500 && status !== 501)) return true;
    if (NON_RETRYABLE_4XX.has(status)) return false;
    // Other 4xx codes are normally deterministic too, but gateways and relays
    // surface transient failures under odd ones (a 409 wrapping an upstream
    // failure), recognizable only by what the error says.
    return matchesRetryablePattern(error.message) || matchesRetryablePattern(responseBodyOf(error));
  }
  // No status at all: only a genuine network failure merits a resend.
  return isNetworkFailure(error);
}

export const RETRY_JITTER_FACTOR = 0.25;
// The wait between attempts never exceeds this, even when a Retry-After
// header asks for more: an interactive CLI turn cannot park for minutes.
export const MAX_RETRY_DELAY_MS = 60_000;

// Parses the Retry-After hints an APICallError can carry: retry-after-ms,
// then retry-after in seconds or as an HTTP date. Header names from the AI
// SDK are already lowercase, but normalize defensively.
export function retryAfterDelayMs(error: StreamErrorInfo): number | undefined {
  const headers = error.responseHeaders;
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  const afterMs = Number.parseFloat(normalized["retry-after-ms"] ?? "");
  if (!Number.isNaN(afterMs)) return Math.max(0, afterMs);
  const after = normalized["retry-after"];
  if (after) {
    const seconds = Number.parseFloat(after);
    if (!Number.isNaN(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    const dateMs = Date.parse(after) - Date.now();
    if (!Number.isNaN(dateMs) && dateMs > 0) return Math.ceil(dateMs);
  }
  return undefined;
}

// Milliseconds to wait before the next attempt: the server's Retry-After hint
// when present (capped), otherwise exponential backoff (base × 2^attempt)
// with +0–25% jitter so concurrent clients do not retry in lockstep.
export function computeRetryDelayMs(
  attempt: number,
  baseMs: number,
  error?: StreamErrorInfo | null,
  random: number = Math.random(),
): number {
  const hinted = error ? retryAfterDelayMs(error) : undefined;
  if (hinted !== undefined) return Math.min(hinted, MAX_RETRY_DELAY_MS);
  const base = baseMs * 2 ** attempt;
  return Math.min(Math.ceil(base + base * RETRY_JITTER_FACTOR * random), MAX_RETRY_DELAY_MS);
}

// One-line description of a stream failure for retry notices and logs: the
// message, the HTTP status when the message omits it, and an excerpt of the
// response body when it adds information the message does not have.
export function summarizeStreamError(error: StreamErrorInfo): string {
  const parts = [error.message || error.name];
  const status = error.statusCode;
  if (status !== undefined && !error.message.includes(String(status))) {
    parts.push(`(HTTP ${status})`);
  }
  const body = responseBodyOf(error);
  if (body && !error.message.includes(body.slice(0, 40))) {
    const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 200);
    if (excerpt) parts.push(`— ${excerpt}`);
  }
  return parts.join(" ");
}
