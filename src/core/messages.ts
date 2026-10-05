import type { CoreMessage, ToolCallPart } from "ai";

export type { CoreMessage };

// Side-band metadata the model never sees. It rides next to a persisted
// message (the __starMeta jsonl key) so turn-boundary scans can tell a real
// user turn from a loop-injected user message:
// - "nudge": auto-continue / resume-after-cutoff steering injected mid-turn
// - "bg-report": a finished background subagent's report, delivered mid-turn
// - "tool-image": images a tool (read_image/screenshot) attached mid-turn
export interface MessageMeta {
  synthetic?: "nudge" | "bg-report" | "tool-image";
}

export interface StarMessage {
  message: CoreMessage;
  meta?: MessageMeta;
}

export function toStarMessage(message: CoreMessage | StarMessage): StarMessage {
  return "role" in message ? { message } : message;
}

export function toCoreMessages(messages: readonly StarMessage[]): CoreMessage[] {
  return messages.map((star) => star.message);
}

// A synthetic user message belongs to the turn that precedes it: it is never
// a turn boundary for /undo, /rewind or compaction turn splitting.
export function isSyntheticUserMessage(star: StarMessage): boolean {
  return star.message.role === "user" && star.meta?.synthetic !== undefined;
}

export interface ImageInput {
  path: string;
  mimeType: string;
  /** Base64-encoded image bytes. */
  data: string;
}

export interface MultimodalInput {
  text: string;
  images: ImageInput[];
}

export type ChatInput = string | MultimodalInput;

export interface ConversationState {
  messages: CoreMessage[];
}

export const MISSING_TOOL_RESULT_TEXT = "tool result missing (session was interrupted)";

export function reconcileToolCalls(messages: CoreMessage[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  let pending: { toolCallId: string; toolName: string }[] = [];

  const flushPending = () => {
    for (const call of pending) {
      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            result: MISSING_TOOL_RESULT_TEXT,
          },
        ],
      });
    }
    pending = [];
  };

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      flushPending();
      pending = message.content
        .filter((part): part is ToolCallPart => part.type === "tool-call")
        .map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName }));
    } else if (message.role === "tool" && Array.isArray(message.content) && pending.length > 0) {
      const answered = new Set(message.content.map((part) => part.toolCallId));
      pending = pending.filter((call) => !answered.has(call.toolCallId));
    } else {
      flushPending();
    }
    result.push(message);
  }
  flushPending();
  return result;
}

// StarMessage counterpart of reconcileToolCalls: same repair, preserving the
// side-band meta of every surviving message. Synthetic filler results carry
// no meta.
export function reconcileStarMessages(messages: readonly StarMessage[]): StarMessage[] {
  const result: StarMessage[] = [];
  let pending: { toolCallId: string; toolName: string }[] = [];

  const flushPending = () => {
    for (const call of pending) {
      result.push({
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: MISSING_TOOL_RESULT_TEXT,
            },
          ],
        },
      });
    }
    pending = [];
  };

  for (const star of messages) {
    const message = star.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      flushPending();
      pending = message.content
        .filter((part): part is ToolCallPart => part.type === "tool-call")
        .map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName }));
    } else if (message.role === "tool" && Array.isArray(message.content) && pending.length > 0) {
      const answered = new Set(message.content.map((part) => part.toolCallId));
      pending = pending.filter((call) => !answered.has(call.toolCallId));
    } else {
      flushPending();
    }
    result.push(star);
  }
  flushPending();
  return result;
}

// Removes the last conversation turn: the final user message and everything
// after it (assistant text, tool calls and results belonging to that turn).
// Synthetic user messages (auto-continue nudges, background reports, tool
// images) belong to the turn they sit in, so the scan skips them and the
// boundary lands on the real user message that opened the turn. A leading
// system message is never touched. Returns the trimmed list and how many
// messages were dropped (0 = nothing to retract).
export function retractLastTurn(messages: StarMessage[]): {
  messages: StarMessage[];
  removed: number;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const star = messages[i];
    if (star && star.message.role === "user" && !isSyntheticUserMessage(star)) {
      return { messages: messages.slice(0, i), removed: messages.length - i };
    }
  }
  return { messages, removed: 0 };
}
