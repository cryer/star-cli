import type { StarMessage } from "../core/messages";
import { estimateMessageTokens } from "./tokens";

// Elision only earns its history rewrite once the window is filling; below
// this fraction of the compaction threshold the history stays untouched, so
// short sessions never elide.
const ACTIVATION_FRACTION = 0.5;
// The newest messages are the model's active working set and are never
// touched; value decay only justifies elision well behind the frontier.
const KEEP_RECENT_MESSAGES = 24;
// A tool result smaller than this is cheaper to keep than to re-fetch.
const MIN_ELISION_TOKENS = 250;

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
): ElisionResult | null {
  let total = overheadTokens;
  for (const star of messages) total += estimateMessageTokens(star.message);
  if (total < thresholdTokens * ACTIVATION_FRACTION) return null;
  const cutoff = messages.length - KEEP_RECENT_MESSAGES;
  if (cutoff <= 0) return null;

  let elidedCount = 0;
  const out = messages.slice();
  for (let i = 0; i < cutoff; i++) {
    const star = out[i];
    if (!star || star.meta?.elided) continue;
    const message = star.message;
    if (message.role === "tool") {
      if (estimateMessageTokens(message) < MIN_ELISION_TOKENS) continue;
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
      if (estimateMessageTokens(message) < MIN_ELISION_TOKENS) continue;
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
