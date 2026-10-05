import { type LanguageModelV1, generateText } from "ai";
import { type CoreMessage, type StarMessage, isSyntheticUserMessage } from "../core/messages";
import { estimateMessageTokens } from "./tokens";

export interface CompactionResult {
  messages: StarMessage[];
  compacted: boolean;
  droppedCount: number;
}

const MIN_KEPT_MESSAGES = 4;

function placeholderMessage(droppedCount: number): StarMessage {
  return {
    message: {
      role: "user",
      content: `[context compacted: ${droppedCount} earlier messages dropped]`,
    },
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

// Collects the first `budget` chars of the virtual newline-joined transcript
// without ever building it; exactly mirrors joined.slice(0, budget).
function headSlice(parts: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= budget) break;
    const sep = kept.length > 0 ? 1 : 0;
    if (used + sep + part.length <= budget) {
      kept.push(part);
      used += sep + part.length;
    } else {
      kept.push(part.slice(0, budget - used - sep));
      used = budget;
    }
  }
  return kept.join("\n");
}

// Mirror of headSlice for the tail: exactly joined.slice(-budget).
function tailSlice(parts: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (used >= budget) break;
    const part = parts[i] ?? "";
    const sep = kept.length > 0 ? 1 : 0;
    if (used + sep + part.length <= budget) {
      kept.unshift(part);
      used += sep + part.length;
    } else {
      kept.unshift(part.slice(part.length - (budget - used - sep)));
      used = budget;
    }
  }
  return kept.join("\n");
}

// Serializes messages straight into the capped summary input: per-message
// strings are collected within the head/tail budgets and the megabyte-scale
// joined transcript is never materialized. Output is byte-identical to
// truncateSummaryInput(parts.join("\n")), omission count included.
export function serializeSummaryInput(messages: CoreMessage[]): string {
  const parts = messages.map(serializeMessage);
  let total = Math.max(0, parts.length - 1);
  for (const part of parts) total += part.length;
  if (total <= MAX_SUMMARY_INPUT_CHARS) return parts.join("\n");
  const head = headSlice(parts, SUMMARY_HEAD_CHARS);
  const tail = tailSlice(parts, MAX_SUMMARY_INPUT_CHARS - SUMMARY_HEAD_CHARS);
  return `${head}\n[... ${total - MAX_SUMMARY_INPUT_CHARS} characters omitted ...]\n${tail}`;
}

export async function summarizeMessages(
  messages: CoreMessage[],
  model: LanguageModelV1,
  signal?: AbortSignal,
  // The calling model's configured sampling temperature, forwarded so
  // endpoints that mandate one explicit value don't reject the summary call.
  temperature?: number,
): Promise<string> {
  const transcript = serializeSummaryInput(messages);
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
  // Fixed per-request overhead charged against the budget: the API window
  // also carries the tool map's JSON schemas (estimateToolSchemaTokens), so
  // the message estimate alone systematically under-reads how full the
  // window is. Estimated once per built tool map by the agent loop.
  overheadTokens?: number;
}

export function compactMessages(
  messages: readonly StarMessage[],
  maxTokens: number,
  opts: CompactOptions = {},
): CompactionResult {
  // Forced compaction uses a zero budget: the under-budget exits below never
  // fire, so turns are dropped until only MIN_KEPT_MESSAGES would remain.
  const limit = opts.force ? 0 : maxTokens;
  const overhead = opts.overheadTokens ?? 0;
  // Estimate every message once, up front: estimates are cached per message
  // object (tokens.ts), so across the loop's per-step calls this only pays
  // for newly appended messages. The early exit, the turn sums and the
  // incremental drop loop all read from this array — no CoreMessage[] copies
  // and no re-estimation per step.
  const tokens = messages.map((star) => estimateMessageTokens(star.message));
  let total = overhead;
  for (const messageTokens of tokens) total += messageTokens;
  if (total <= limit) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  const hasSystem = messages[0]?.message.role === "system";
  const head = hasSystem ? [messages[0] as StarMessage] : [];
  const restStart = hasSystem ? 1 : 0;
  const restCount = messages.length - restStart;

  // Sum each turn's tokens once and subtract incrementally while dropping:
  // rebuilding the candidate array and re-estimating it whole after every
  // dropped turn made forced /compact O(n²) on long histories. Per-message
  // estimates are cached (tokens.ts), so the placeholder's tiny string is
  // the only fresh work per iteration.
  const headTokens = hasSystem ? (tokens[0] ?? 0) : 0;
  let restTokens = 0;
  for (let i = restStart; i < tokens.length; i++) restTokens += tokens[i] ?? 0;
  // Turns split at real user messages only: a synthetic user message (an
  // auto-continue nudge, a background subagent report, tool-attached images)
  // belongs to the turn it sits in and must drop — and stay — with it.
  const turns: { length: number; tokens: number }[] = [];
  for (let i = restStart; i < messages.length; i++) {
    const current = turns[turns.length - 1];
    const star = messages[i];
    if ((star && star.message.role === "user" && !isSyntheticUserMessage(star)) || !current) {
      turns.push({ length: 1, tokens: tokens[i] ?? 0 });
    } else {
      current.length += 1;
      current.tokens += tokens[i] ?? 0;
    }
  }

  let droppedCount = 0;
  let droppedTokens = 0;
  for (const turn of turns) {
    if (restCount - droppedCount - turn.length < MIN_KEPT_MESSAGES) {
      break;
    }
    droppedCount += turn.length;
    droppedTokens += turn.tokens;
    const candidateTokens =
      overhead +
      headTokens +
      estimateMessageTokens(placeholderMessage(droppedCount).message) +
      (restTokens - droppedTokens);
    if (candidateTokens <= limit) {
      break;
    }
  }

  if (droppedCount === 0) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  return {
    messages: [
      ...head,
      placeholderMessage(droppedCount),
      ...messages.slice(restStart + droppedCount),
    ],
    compacted: true,
    droppedCount,
  };
}
