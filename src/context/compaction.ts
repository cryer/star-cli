import { type LanguageModelV1, generateText } from "ai";
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

const SUMMARY_SYSTEM_PROMPT = [
  "You are summarizing an AI coding agent's conversation for context compaction.",
  "Write a concise summary that preserves:",
  "- the user's goals and requests",
  "- decisions made and their rationale",
  "- files and code touched (paths, key changes)",
  "- tool results that matter (errors, key outputs)",
  "- outstanding TODOs and next steps",
  "Output only the summary, no preamble.",
].join("\n");

function serializeMessage(message: CoreMessage): string {
  if (typeof message.content === "string") {
    return `${message.role}: ${message.content}`;
  }
  const parts = message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "tool-call")
      return `[tool-call ${part.toolName}] ${JSON.stringify(part.args)}`;
    if (part.type === "tool-result")
      return `[tool-result ${part.toolName}] ${JSON.stringify(part.result)}`;
    return `[${part.type}]`;
  });
  return `${message.role}: ${parts.join("\n")}`;
}

export async function summarizeMessages(
  messages: CoreMessage[],
  model: LanguageModelV1,
  signal?: AbortSignal,
): Promise<string> {
  const transcript = messages.map(serializeMessage).join("\n");
  const { text } = await generateText({
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: `Summarize this conversation so far:\n\n${transcript}`,
    // A hung relay must not stall the whole turn on the summary: cap it at
    // 60s and let the caller's abort (Esc) cut it short as well; the caller
    // falls back to the truncation placeholder on any failure.
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  return text.trim();
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
