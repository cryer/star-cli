import { type LanguageModelV1, generateText } from "ai";
import type { CoreMessage } from "../core/messages";
import { estimateMessageTokens, estimateTokens } from "./tokens";

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

// Cap the summarizer's own input: a long session's dropped transcript can be
// megabytes of tool output, and the summary call is billed too. The head
// (original task) and tail (most recent state) carry what a summary needs.
const MAX_SUMMARY_INPUT_CHARS = 80_000;
const SUMMARY_HEAD_CHARS = 24_000;

export function truncateSummaryInput(transcript: string): string {
  if (transcript.length <= MAX_SUMMARY_INPUT_CHARS) return transcript;
  const tailChars = MAX_SUMMARY_INPUT_CHARS - SUMMARY_HEAD_CHARS;
  const omitted = transcript.length - MAX_SUMMARY_INPUT_CHARS;
  return `${transcript.slice(0, SUMMARY_HEAD_CHARS)}\n[... ${omitted} characters omitted ...]\n${transcript.slice(-tailChars)}`;
}

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
  // The calling model's configured sampling temperature, forwarded so
  // endpoints that mandate one explicit value don't reject the summary call.
  temperature?: number,
): Promise<string> {
  const transcript = truncateSummaryInput(messages.map(serializeMessage).join("\n"));
  const { text } = await generateText({
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: `Summarize this conversation so far:\n\n${transcript}`,
    temperature,
    // A hung relay must not stall the whole turn on the summary: cap it at
    // 60s and let the caller's abort (Esc) cut it short as well; the caller
    // falls back to the truncation placeholder on any failure.
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  return text.trim();
}

export interface CompactOptions {
  // Manual /compact: compact even when under the token budget, dropping whole
  // turns down to MIN_KEPT_MESSAGES instead of refusing. Auto-compaction in
  // the agent loop never forces.
  force?: boolean;
}

export function compactMessages(
  messages: CoreMessage[],
  maxTokens: number,
  opts: CompactOptions = {},
): CompactionResult {
  // Forced compaction uses a zero budget: the under-budget exits below never
  // fire, so turns are dropped until only MIN_KEPT_MESSAGES would remain.
  const limit = opts.force ? 0 : maxTokens;
  if (estimateTokens(messages) <= limit) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const first = messages[0];
  const hasSystem = first?.role === "system";
  const head = hasSystem && first ? [first] : [];
  const rest = hasSystem ? messages.slice(1) : messages.slice();

  // Sum each turn's tokens once and subtract incrementally while dropping:
  // rebuilding the candidate array and re-estimating it whole after every
  // dropped turn made forced /compact O(n²) on long histories. Per-message
  // estimates are cached (tokens.ts), so the placeholder's tiny string is
  // the only fresh work per iteration.
  const messageTokens = rest.map((message) => estimateMessageTokens(message));
  const turns: { length: number; tokens: number }[] = [];
  for (let i = 0; i < rest.length; i++) {
    const current = turns[turns.length - 1];
    if (rest[i]?.role === "user" || !current) {
      turns.push({ length: 1, tokens: messageTokens[i] ?? 0 });
    } else {
      current.length += 1;
      current.tokens += messageTokens[i] ?? 0;
    }
  }

  const headTokens = estimateTokens(head);
  const restTokens = estimateTokens(rest);
  let droppedCount = 0;
  let droppedTokens = 0;
  for (const turn of turns) {
    if (rest.length - droppedCount - turn.length < MIN_KEPT_MESSAGES) {
      break;
    }
    droppedCount += turn.length;
    droppedTokens += turn.tokens;
    const candidateTokens =
      headTokens +
      estimateMessageTokens(placeholderMessage(droppedCount)) +
      (restTokens - droppedTokens);
    if (candidateTokens <= limit) {
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
