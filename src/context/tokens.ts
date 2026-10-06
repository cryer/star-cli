import { zodSchema } from "ai";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { z } from "zod";
import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const IMAGE_PART_TOKENS = 1024;

// Chat content can legitimately contain BPE special-token strings
// (<|endoftext|> …) pasted from logs or other models; an empty disallowed
// set encodes them as ordinary text instead of throwing, so the estimate
// never fails on real conversations.
const ENCODE_OPTIONS = { disallowedSpecial: new Set<string>() };

// Real BPE counting (cl100k_base) replaces the chars-per-token heuristic:
// the heuristic under-reads punctuation-heavy code and JSON by 15-30%, which
// let the ctx% display and the auto-compaction threshold trigger late.
// cl100k is pinned explicitly (not the library default) so a dependency
// upgrade can't silently change the estimator, and because it counts
// slightly high for CJK — overestimating compacts early, underestimating
// overflows the window. Non-OpenAI models have their own tokenizers, but
// any real BPE count sits far closer to them than a char rule does; the
// provider's reported usage still owns billing.
function countTextTokens(text: string): number {
  if (text.length === 0) return 0;
  try {
    return encode(text, ENCODE_OPTIONS).length;
  } catch {
    return Math.ceil(textWeight(text) / CHARS_PER_TOKEN);
  }
}

// CJK characters map to roughly one token each, while Latin text averages
// ~4 chars/token. Weight a CJK char as CHARS_PER_TOKEN units so the final
// division lands near 1 token/char — otherwise Chinese-heavy conversations
// are underestimated ~4x. Ranges: CJK punctuation, kana, ext-A, unified
// ideographs, compat ideographs, fullwidth forms. Numeric code-unit
// comparisons instead of a per-char regex: several times faster on the long
// tool-result strings this runs over, with identical results (surrogate
// halves never fall in these ranges). Only used as the fallback when the
// BPE encoder itself fails.
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function textWeight(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk++;
  }
  return text.length + cjk * (CHARS_PER_TOKEN - 1);
}

function contentTokenLength(message: CoreMessage): number {
  if (message.role === "tool") {
    let tokens = 0;
    for (const part of message.content) {
      tokens += countTextTokens(JSON.stringify(part.result ?? null));
    }
    return tokens;
  }
  if (typeof message.content === "string") {
    return countTextTokens(message.content);
  }
  let tokens = 0;
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      tokens += countTextTokens(part.text);
    } else if (part.type === "tool-call") {
      tokens += countTextTokens(part.toolName) + countTextTokens(JSON.stringify(part.args ?? null));
    }
  }
  return tokens;
}

function imagePartCount(message: CoreMessage): number {
  if (typeof message.content === "string" || message.role === "tool") return 0;
  return message.content.filter((part) => part.type === "image" || part.type === "file").length;
}

// Messages are immutable once they enter a loop's history (the system
// message slot is replaced, never edited in place — see syncSystemMessage
// in agent/loop.ts), so an identity-keyed cache never serves a stale count.
// The agent loop re-estimates the whole history every step; caching per
// message object keeps that O(new messages) instead of O(history), and the
// JSON.stringify of big tool results/args plus the BPE encode in
// contentTokenLength runs once per message instead of once per step — the
// tokenizer costs ~40ms per 1MB on first sight, 0 afterwards.
const tokenCache = new WeakMap<CoreMessage, number>();

export function estimateMessageTokens(message: CoreMessage): number {
  const cached = tokenCache.get(message);
  if (cached !== undefined) return cached;
  const tokens =
    contentTokenLength(message) + MESSAGE_OVERHEAD + imagePartCount(message) * IMAGE_PART_TOKENS;
  tokenCache.set(message, tokens);
  return tokens;
}

export function estimateTokens(messages: readonly CoreMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

// Serializes a tool's parameters the way the request carries them. Zod
// schemas (what every registered tool declares) convert to their wire JSON
// schema through the AI SDK — serializing the zod object itself would skip
// the shape (it sits behind a closure) and under-read badly. An SDK Schema
// wrapper (jsonSchema()) is unwrapped directly.
function parametersWireJson(parameters: unknown): string {
  if (parameters == null) return "";
  const wrapper = parameters as { jsonSchema?: unknown };
  if (wrapper.jsonSchema !== undefined) {
    try {
      return JSON.stringify(wrapper.jsonSchema) ?? "";
    } catch {
      return "";
    }
  }
  try {
    return JSON.stringify(zodSchema(parameters as z.ZodType).jsonSchema) ?? "";
  } catch {
    try {
      return JSON.stringify(parameters) ?? "";
    } catch {
      return "";
    }
  }
}

// The fixed per-request overhead the message-only estimate never sees: every
// request carries the whole tool map as JSON schemas, and on a 15+ tool setup
// that is several thousand tokens — ignoring it systematically under-reads
// how full the window really is. The agent loop estimates this once per built
// tool map (registry and plan filter are stable while it lives) and charges
// it into the auto-compaction check; a schema that cannot be serialized
// contributes nothing rather than failing the estimate.
export function estimateToolSchemaTokens(tools: Record<string, unknown>): number {
  let tokens = 0;
  for (const [name, tool] of Object.entries(tools)) {
    tokens += countTextTokens(name);
    const description = (tool as { description?: unknown }).description;
    if (typeof description === "string") tokens += countTextTokens(description);
    tokens += countTextTokens(parametersWireJson((tool as { parameters?: unknown }).parameters));
  }
  return tokens;
}
