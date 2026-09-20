import type { CoreMessage, ToolCallPart } from "ai";

export type { CoreMessage };

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

// Removes the last conversation turn: the final user message and everything
// after it (assistant text, tool calls and results belonging to that turn).
// A leading system message is never touched. Returns the trimmed list and
// how many messages were dropped (0 = nothing to retract).
export function retractLastTurn(messages: CoreMessage[]): {
  messages: CoreMessage[];
  removed: number;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return { messages: messages.slice(0, i), removed: messages.length - i };
    }
  }
  return { messages, removed: 0 };
}
