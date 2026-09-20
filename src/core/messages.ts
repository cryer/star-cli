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
