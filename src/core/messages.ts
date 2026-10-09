import type { CoreMessage, ToolCallPart } from "ai";

export type { CoreMessage };

// Side-band metadata the model never sees. It rides next to a persisted
// message (the __starMeta jsonl key) so turn-boundary scans can tell a real
// user turn from a loop-injected user message:
// - "nudge": auto-continue / resume-after-cutoff steering injected mid-turn
// - "bg-report": a finished background subagent's report, delivered mid-turn
// - "tool-image": images a tool (read_image/screenshot) attached mid-turn
// - "steer": a user prompt injected into the running turn (chosen at submit
//   time over queueing), delivered at the next step boundary
export interface MessageMeta {
  synthetic?: "nudge" | "bg-report" | "tool-image" | "steer";
  // Set by context/elision.ts when the message's bulky content (a stale tool
  // result, an old attached image) was replaced with a placeholder to free
  // the window — idempotency marker and debugging aid; the model never sees it.
  elided?: boolean;
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

// Plain-text content of a message: string content as-is; for array content,
// the text parts joined with a space (tool calls, images and tool results
// contribute nothing). Shared by the agent loop (/redo labels) and the CLI
// (history rendering, conversation copy) so the extraction rule lives once.
export function coreMessageText(message: CoreMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join(" ");
  }
  return "";
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

// A tool call that has no real execution result must still be closed with a
// synthetic tool message, or the stored history can no longer be sent to the
// API. Three scenarios, three wordings:
// - MISSING_TOOL_RESULT_TEXT: reconcileToolCalls/reconcileStarMessages repair
//   a persisted history whose session ended before the results were written
//   (crash, kill, older version) — the call may never have run at all.
// - INTERRUPTED_TOOL_RESULT_TEXT: the user pressed Esc while the call was
//   still streaming in or executing (agent loop abort paths).
// - UNFINISHED_TOOL_RESULT_TEXT: execution stopped for any other reason
//   (e.g. an error mid-batch) before the call produced a result.
export const MISSING_TOOL_RESULT_TEXT = "tool result missing (session was interrupted)";
export const INTERRUPTED_TOOL_RESULT_TEXT = "Tool execution interrupted by user.";
export const UNFINISHED_TOOL_RESULT_TEXT =
  "Tool execution interrupted before a result was produced.";

export function reconcileToolCalls(messages: CoreMessage[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  let pending: { toolCallId: string; toolName: string }[] = [];
  // Non-tool messages that arrived while a tool-call batch was still open
  // (e.g. tool-attached image messages persisted by a version that
  // interleaved them between sibling tool results) are held back and emitted
  // once the batch closes: strict providers reject a user message sitting
  // inside the tool-result block ("an assistant message with 'tool_calls'
  // must be followed by tool messages"), and flushing synthetic fillers at
  // that point would also duplicate the real results that follow.
  let deferred: CoreMessage[] = [];

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
    result.push(...deferred);
    deferred = [];
  };

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      flushPending();
      pending = message.content
        .filter((part): part is ToolCallPart => part.type === "tool-call")
        .map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName }));
      result.push(message);
    } else if (message.role === "tool" && Array.isArray(message.content) && pending.length > 0) {
      const answered = new Set(message.content.map((part) => part.toolCallId));
      pending = pending.filter((call) => !answered.has(call.toolCallId));
      result.push(message);
      if (pending.length === 0) {
        result.push(...deferred);
        deferred = [];
      }
    } else if (pending.length > 0) {
      deferred.push(message);
    } else {
      result.push(message);
    }
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
  let deferred: StarMessage[] = [];

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
    result.push(...deferred);
    deferred = [];
  };

  for (const star of messages) {
    const message = star.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      flushPending();
      pending = message.content
        .filter((part): part is ToolCallPart => part.type === "tool-call")
        .map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName }));
      result.push(star);
    } else if (message.role === "tool" && Array.isArray(message.content) && pending.length > 0) {
      const answered = new Set(message.content.map((part) => part.toolCallId));
      pending = pending.filter((call) => !answered.has(call.toolCallId));
      result.push(star);
      if (pending.length === 0) {
        result.push(...deferred);
        deferred = [];
      }
    } else if (pending.length > 0) {
      deferred.push(star);
    } else {
      result.push(star);
    }
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
