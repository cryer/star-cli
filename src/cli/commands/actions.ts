import fs from "node:fs/promises";
import path from "node:path";
import type { LanguageModel } from "ai";
import { AgentLoop } from "../../agent/loop";
import type { StarConfig } from "../../config/schema";
import { compactMessages, summarizeMessages } from "../../context/compaction";
import type { CompactionResult } from "../../context/compaction";
import { estimateTokens } from "../../context/tokens";
import type { CoreMessage } from "../../core/messages";
import type { SessionStore } from "../../session/store";
import type { ChatBackend } from "../backend";

const MIN_COMPACT_MESSAGES = 4;

export interface CompactSessionOptions {
  backend: ChatBackend;
  sessionStore: SessionStore | null;
  config: StarConfig;
  model: LanguageModel | null;
}

export interface CompactSessionResult {
  message: string;
  compacted: boolean;
  messages?: CoreMessage[];
}

export async function compactSession(opts: CompactSessionOptions): Promise<CompactSessionResult> {
  const { backend, sessionStore, config, model } = opts;
  if (!(backend instanceof AgentLoop)) {
    return { message: "Current backend does not support compaction.", compacted: false };
  }
  const messages = [...backend.getMessages()];
  if (messages.length < MIN_COMPACT_MESSAGES) {
    return {
      message: `Nothing to compact: history has only ${messages.length} message(s).`,
      compacted: false,
    };
  }
  const beforeTokens = estimateTokens(messages);
  const compacted = compactMessages(messages, config.contextMaxTokens);
  if (!compacted.compacted) {
    return {
      message: `Nothing to compact: ~${beforeTokens} estimated tokens, below the limit of ${config.contextMaxTokens}.`,
      compacted: false,
    };
  }
  const next = await applyCompactionSummary(messages, compacted, config, model);
  await backend.loadMessages(next);
  await sessionStore?.replaceMessages(next);
  const afterTokens = estimateTokens(next);
  return {
    message: `Compacted context: ${messages.length} -> ${next.length} messages (~${beforeTokens} -> ~${afterTokens} estimated tokens).`,
    compacted: true,
    messages: next,
  };
}

async function applyCompactionSummary(
  original: CoreMessage[],
  compacted: CompactionResult,
  config: StarConfig,
  model: LanguageModel | null,
): Promise<CoreMessage[]> {
  if (config.contextCompaction !== "summary" || !model) {
    return compacted.messages;
  }
  const headCount = compacted.messages[0]?.role === "system" ? 1 : 0;
  const dropped = original.slice(headCount, headCount + compacted.droppedCount);
  try {
    const summary = await summarizeMessages(dropped, model);
    const messages = compacted.messages.slice();
    messages[headCount] = {
      role: "user",
      content: `[earlier conversation summarized]\n${summary}`,
    };
    return messages;
  } catch {
    return compacted.messages;
  }
}

export interface ExportSessionOptions {
  backend: ChatBackend;
  sessionStore: SessionStore | null;
  cwd: string;
  arg: string;
}

export async function exportSession(opts: ExportSessionOptions): Promise<string> {
  const { backend, sessionStore, cwd, arg } = opts;
  if (!(backend instanceof AgentLoop)) {
    return "Current backend does not support exporting sessions.";
  }
  const messages = [...backend.getMessages()];
  if (messages.length === 0) {
    return "Nothing to export: the session has no messages.";
  }
  const sessionId = sessionStore?.id ?? `unknown-${Date.now()}`;
  const target = arg ? path.resolve(cwd, arg) : path.resolve(cwd, `star-session-${sessionId}.md`);
  const existed = await fileExists(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderSessionMarkdown(sessionId, messages));
  return existed
    ? `Exported ${messages.length} messages to ${target} (overwrote existing file).`
    : `Exported ${messages.length} messages to ${target}.`;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function renderSessionMarkdown(
  sessionId: string,
  messages: readonly CoreMessage[],
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [
    `# Star CLI Session ${sessionId}`,
    "",
    `_Exported at ${exportedAt.toISOString()}_`,
    "",
  ];
  for (const message of messages) {
    lines.push(`## ${roleHeading(message.role)}`, "");
    lines.push(...renderContent(message), "");
  }
  return lines.join("\n");
}

function roleHeading(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function renderContent(message: CoreMessage): string[] {
  const content = message.content;
  if (typeof content === "string") return [content];
  const lines: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      lines.push(part.text, "");
    } else if (part.type === "tool-call") {
      lines.push(
        `**Tool call: ${part.toolName}**`,
        "",
        "```json",
        JSON.stringify(part.args, null, 2),
        "```",
        "",
      );
    } else if (part.type === "tool-result") {
      lines.push(
        `**Tool result: ${part.toolName}**`,
        "",
        "```",
        stringifyPart(part.result),
        "```",
        "",
      );
    } else if (part.type === "reasoning") {
      lines.push(part.text, "");
    } else {
      lines.push(`[${part.type}]`, "");
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function stringifyPart(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
