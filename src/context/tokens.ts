import { zodSchema } from "ai";
import type { z } from "zod";
import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const IMAGE_PART_TOKENS = 1024;

// CJK characters map to roughly one token each, while Latin text averages
// ~4 chars/token. Weight a CJK char as CHARS_PER_TOKEN units so the final
// division lands near 1 token/char — otherwise Chinese-heavy conversations
// are underestimated ~4x. Ranges: CJK punctuation, kana, ext-A, unified
// ideographs, compat ideographs, fullwidth forms. Numeric code-unit
// comparisons instead of a per-char regex: several times faster on the long
// tool-result strings this runs over, with identical results (surrogate
// halves never fall in these ranges).
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

function contentCharLength(message: CoreMessage): number {
  if (message.role === "tool") {
    let chars = 0;
    for (const part of message.content) {
      chars += textWeight(JSON.stringify(part.result ?? null));
    }
    return chars;
  }
  if (typeof message.content === "string") {
    return textWeight(message.content);
  }
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += textWeight(part.text);
    } else if (part.type === "tool-call") {
      chars += textWeight(part.toolName) + textWeight(JSON.stringify(part.args ?? null));
    }
  }
  return chars;
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
// JSON.stringify of big tool results/args in contentCharLength runs once
// per message instead of once per step.
const tokenCache = new WeakMap<CoreMessage, number>();

export function estimateMessageTokens(message: CoreMessage): number {
  const cached = tokenCache.get(message);
  if (cached !== undefined) return cached;
  const tokens =
    Math.ceil(contentCharLength(message) / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD +
    imagePartCount(message) * IMAGE_PART_TOKENS;
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
  let weight = 0;
  for (const [name, tool] of Object.entries(tools)) {
    weight += textWeight(name);
    const description = (tool as { description?: unknown }).description;
    if (typeof description === "string") weight += textWeight(description);
    weight += textWeight(parametersWireJson((tool as { parameters?: unknown }).parameters));
  }
  return Math.ceil(weight / CHARS_PER_TOKEN);
}
