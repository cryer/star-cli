import type { CoreMessage } from "../core/messages";
import { estimateTokens } from "./tokens";

export interface CompactionResult {
  messages: CoreMessage[];
  compacted: boolean;
  droppedCount: number;
}

const MIN_KEPT_MESSAGES = 4;

function placeholderMessage(droppedCount: number): CoreMessage {
  return {
    role: "user",
    content: `[context compacted: ${droppedCount} earlier messages dropped]`,
  };
}

export function compactMessages(messages: CoreMessage[], maxTokens: number): CompactionResult {
  if (estimateTokens(messages) <= maxTokens) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const first = messages[0];
  const hasSystem = first?.role === "system";
  const head = hasSystem && first ? [first] : [];
  const rest = hasSystem ? messages.slice(1) : messages.slice();

  const turns: CoreMessage[][] = [];
  for (const message of rest) {
    const current = turns[turns.length - 1];
    if (message.role === "user" || !current) {
      turns.push([message]);
    } else {
      current.push(message);
    }
  }

  let droppedCount = 0;
  let turnIndex = 0;
  while (turnIndex < turns.length) {
    const turn = turns[turnIndex] as CoreMessage[];
    if (rest.length - droppedCount - turn.length < MIN_KEPT_MESSAGES) {
      break;
    }
    droppedCount += turn.length;
    turnIndex += 1;
    const candidate = [...head, placeholderMessage(droppedCount), ...rest.slice(droppedCount)];
    if (estimateTokens(candidate) <= maxTokens) {
      break;
    }
  }

  if (droppedCount === 0) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  return {
    messages: [...head, placeholderMessage(droppedCount), ...rest.slice(droppedCount)],
    compacted: true,
    droppedCount,
  };
}
