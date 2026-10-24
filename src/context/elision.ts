import type { StarMessage } from "../core/messages";
import { estimateMessageTokens } from "./tokens";

// Elision only earns its history rewrite once the window is filling; below
// this fraction of the compaction threshold the history stays untouched, so
// short sessions never elide. Configurable via elisionThresholdFraction.
export const DEFAULT_ELISION_ACTIVATION_FRACTION = 0.5;
// The newest messages are the model's active working set and are never
// touched; value decay only justifies elision well behind the frontier.
// Configurable via elisionKeepRecentMessages.
export const DEFAULT_ELISION_KEEP_RECENT_MESSAGES = 24;
// A tool result smaller than this is cheaper to keep than to re-fetch.
// Configurable via elisionMinTokens.
export const DEFAULT_ELISION_MIN_TOKENS = 250;

export interface ElisionOptions {
  activationFraction?: number;
  keepRecentMessages?: number;
  minTokens?: number;
}

export const ELIDED_TOOL_RESULT_TEXT =
  "[stale tool output elided to free context — it was shown in full earlier; re-run the tool if you need it again]";
export const ELIDED_IMAGE_TEXT =
  "[image elided to free context — re-attach it if it is still needed]";
// Old tool calls keep their id and name (the tool-call ↔ tool-result
// pairing is protocol-critical) but their arguments are dead weight once
// the call has run — a write_file from 40 messages ago carries the whole
// file body in its args, and unlike a tool result that bulk was never
// elidable, so write-heavy sessions grew until the window overflowed. The
// placeholder deliberately is NOT valid tool input (a schema-invalid whole
// -args object): a model imitating it produces a call that fails validation
// and gets the error fed back, never an execution.
export const ELIDED_TOOL_CALL_ARGS_TEXT =
  "arguments elided to free context — the call already ran; this placeholder is not valid tool input, re-read the file if you need the old content";

export interface ElisionResult {
  messages: StarMessage[];
  elidedCount: number;
}

// Stale-content elision: whole-turn compaction throws away the conversation
// narrative when the real dead weight is old bulk — a file read 40 messages
// ago whose contents have been edited since, the file body a long-ago
// write_file carried in its arguments, a screenshot attached long ago.
// Those get replaced in place with a placeholder: message count and order
// are unchanged, so /undo turn markers stay valid (unlike compaction), the
// assistant's tool-call ↔ tool-result pairing survives protocol-valid (a
// gutted tool call keeps its id and name), and the history often shrinks
// enough that compaction never fires.
//
// Runs before the per-step compaction check; the caller persists the
// rewrite exactly like compaction and resets volatile tool state (the
// read_file dedup cache must not claim elided content is still in context).
export function elideStaleContent(
  messages: readonly StarMessage[],
  thresholdTokens: number,
  overheadTokens = 0,
  options: ElisionOptions = {},
): ElisionResult | null {
  const activationFraction = options.activationFraction ?? DEFAULT_ELISION_ACTIVATION_FRACTION;
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_ELISION_KEEP_RECENT_MESSAGES;
  const minTokens = options.minTokens ?? DEFAULT_ELISION_MIN_TOKENS;
  let total = overheadTokens;
  for (const star of messages) total += estimateMessageTokens(star.message);
  if (total < thresholdTokens * activationFraction) return null;
  const cutoff = messages.length - keepRecentMessages;
  if (cutoff <= 0) return null;

  let elidedCount = 0;
  const out = messages.slice();
  for (let i = 0; i < cutoff; i++) {
    const star = out[i];
    if (!star || star.meta?.elided) continue;
    const message = star.message;
    if (message.role === "tool") {
      if (estimateMessageTokens(message) < minTokens) continue;
      out[i] = {
        message: {
          ...message,
          content: message.content.map((part) => ({
            ...part,
            result: ELIDED_TOOL_RESULT_TEXT,
          })),
        },
        meta: { ...star.meta, elided: true },
      };
      elidedCount++;
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      if (!message.content.some((part) => part.type === "tool-call")) continue;
      if (estimateMessageTokens(message) < minTokens) continue;
      out[i] = {
        message: {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-call"
              ? { ...part, args: { elided: ELIDED_TOOL_CALL_ARGS_TEXT } }
              : part,
          ),
        },
        meta: { ...star.meta, elided: true },
      };
      elidedCount++;
    } else if (message.role === "user" && Array.isArray(message.content)) {
      if (!message.content.some((part) => part.type === "image" || part.type === "file")) continue;
      out[i] = {
        message: {
          ...message,
          content: message.content.map((part) =>
            part.type === "image" || part.type === "file"
              ? { type: "text" as const, text: ELIDED_IMAGE_TEXT }
              : part,
          ),
        },
        meta: { ...star.meta, elided: true },
      };
      elidedCount++;
    }
  }
  if (elidedCount === 0) return null;
  return { messages: out, elidedCount };
}

export const ELIDED_ASSISTANT_TEXT = "[assistant content elided by emergency context reduction]";

export interface EmergencyElisionOptions {
  minTokens?: number;
}

export interface EmergencyElisionResult extends ElisionResult {
  estimatedTokens: number;
  withinBudget: boolean;
}

function isElidedToolCallArgs(args: unknown): boolean {
  return (
    args !== null &&
    typeof args === "object" &&
    (args as { elided?: unknown }).elided === ELIDED_TOOL_CALL_ARGS_TEXT
  );
}

function emergencyElideMessage(star: StarMessage): StarMessage | null {
  const message = star.message;
  if (message.role === "system") return null;
  if (message.role === "tool") {
    if (message.content.every((part) => part.result === ELIDED_TOOL_RESULT_TEXT)) return null;
    return {
      message: {
        ...message,
        content: message.content.map((part) => ({
          ...part,
          result: ELIDED_TOOL_RESULT_TEXT,
        })),
      },
      meta: { ...star.meta, elided: true },
    };
  }
  if (message.role === "user") {
    if (!Array.isArray(message.content)) return null;
    if (!message.content.some((part) => part.type === "image" || part.type === "file")) {
      return null;
    }
    return {
      message: {
        ...message,
        content: message.content.map((part) =>
          part.type === "image" || part.type === "file"
            ? { type: "text" as const, text: ELIDED_IMAGE_TEXT }
            : part,
        ),
      },
      meta: { ...star.meta, elided: true },
    };
  }
  if (typeof message.content === "string") {
    if (message.content === ELIDED_ASSISTANT_TEXT) return null;
    return {
      message: { ...message, content: ELIDED_ASSISTANT_TEXT },
      meta: { ...star.meta, elided: true },
    };
  }
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type === "tool-call" && !isElidedToolCallArgs(part.args)) {
      changed = true;
      return { ...part, args: { elided: ELIDED_TOOL_CALL_ARGS_TEXT } };
    }
    if (
      (part.type === "text" || part.type === "reasoning") &&
      part.text !== ELIDED_ASSISTANT_TEXT
    ) {
      changed = true;
      return { ...part, text: ELIDED_ASSISTANT_TEXT };
    }
    return part;
  });
  if (!changed) return null;
  return { message: { ...message, content }, meta: { ...star.meta, elided: true } };
}

// Last-resort, in-place reduction after ordinary compaction. Unlike stale
// elision it has no recent-message frontier: oldest bulky messages are reduced
// first, including a single huge result or attachment in the active turn.
// User text and system instructions are never rewritten, and no messages or
// tool-call ids are removed. estimatedTokens includes overheadTokens.
export function emergencyElideContent(
  messages: readonly StarMessage[],
  maxTokens: number,
  overheadTokens = 0,
  options: EmergencyElisionOptions = {},
): EmergencyElisionResult {
  const minTokens = options.minTokens ?? 1;
  const out = messages.slice();
  const tokens = messages.map((star) => estimateMessageTokens(star.message));
  let estimatedTokens = overheadTokens;
  for (const count of tokens) estimatedTokens += count;
  let elidedCount = 0;
  const floors =
    minTokens < DEFAULT_ELISION_MIN_TOKENS ? [DEFAULT_ELISION_MIN_TOKENS, minTokens] : [minTokens];
  for (const floor of floors) {
    for (let i = 0; i < out.length && estimatedTokens > maxTokens; i++) {
      const star = out[i];
      if (!star || (tokens[i] ?? 0) < floor) continue;
      const replacement = emergencyElideMessage(star);
      if (!replacement) continue;
      const replacementTokens = estimateMessageTokens(replacement.message);
      if (replacementTokens >= (tokens[i] ?? 0)) continue;
      out[i] = replacement;
      estimatedTokens += replacementTokens - (tokens[i] ?? 0);
      elidedCount++;
    }
  }
  return {
    messages: out,
    elidedCount,
    estimatedTokens,
    withinBudget: estimatedTokens <= maxTokens,
  };
}
