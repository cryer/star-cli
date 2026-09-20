import type { LanguageModel } from "ai";
import { tool as aiTool } from "ai";
import type { StarConfig } from "../config/schema";
import { type CompactionResult, compactMessages, summarizeMessages } from "../context/compaction";
import type { StreamEvent } from "../core/events";
import { type CoreMessage, reconcileToolCalls, retractLastTurn } from "../core/messages";
import { checkPermission } from "../permissions/gate";
import type { PermissionRequest } from "../permissions/types";
import type { SessionStore } from "../session/store";
import { beginTurn } from "../tools/fs/snapshots";
import type { ToolRegistry } from "../tools/registry";
import type { ToolResult } from "../tools/types";

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  config: StarConfig;
  cwd: string;
  system?: string;
  sessionStore?: SessionStore | null;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

export class AgentLoop {
  private messages: CoreMessage[] = [];
  private readonly opts: AgentLoopOptions;
  // Seq + user-message index of each turn started via stream(); lets /undo
  // match a retracted turn to the file snapshots it produced. Cleared when
  // history is replaced wholesale (resume/compact), because indices no longer
  // line up — in that case /undo only retracts messages, never wrong files.
  private turnMarkers: { seq: number; userIndex: number }[] = [];
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    if (opts.system) {
      this.messages.push({ role: "system", content: opts.system });
    }
  }

  getMessages(): readonly CoreMessage[] {
    return this.messages;
  }

  async loadMessages(messages: CoreMessage[]): Promise<void> {
    this.messages = reconcileToolCalls(messages);
    this.turnMarkers = [];
  }

  // Drops the final user message and everything after it, and persists the
  // trimmed history so a later /resume does not bring the turn back.
  // `turn` is the retracted turn's snapshot seq when it could be verified
  // against the marker recorded at turn start — undefined means the caller
  // must not revert any file snapshots.
  async retractLastTurn(): Promise<{ removed: number; turn?: number }> {
    const result = retractLastTurn([...this.messages]);
    if (result.removed === 0) return { removed: 0 };
    const userIndex = result.messages.length;
    this.messages = result.messages;
    await this.opts.sessionStore?.replaceMessages([...this.messages]);
    const last = this.turnMarkers[this.turnMarkers.length - 1];
    let turn: number | undefined;
    if (last && last.userIndex === userIndex) {
      turn = last.seq;
      this.turnMarkers.pop();
    }
    return { removed: result.removed, turn };
  }

  async appendContextMessage(text: string, role: "user" | "system" = "user"): Promise<void> {
    const message: CoreMessage = { role, content: text };
    this.messages.push(message);
    await this.persist(message);
  }

  private async persist(message: CoreMessage): Promise<void> {
    await this.opts.sessionStore?.append(message);
  }

  async *stream(
    input: string,
    signal: AbortSignal,
    opts?: { persistAs?: string },
  ): AsyncGenerator<StreamEvent> {
    const userMessage: CoreMessage = { role: "user", content: input };
    this.messages.push(userMessage);
    this.turnMarkers.push({ seq: beginTurn(), userIndex: this.messages.length - 1 });
    await this.persist(
      opts?.persistAs !== undefined ? { role: "user", content: opts.persistAs } : userMessage,
    );

    const { config, registry, cwd } = this.opts;
    const aiTools = this.buildAiTools();

    for (let step = 0; step < config.maxSteps; step++) {
      const compacted = compactMessages([...this.messages], config.contextMaxTokens);
      if (compacted.compacted) {
        this.messages = await this.applyCompactionSummary(compacted);
      }

      let text = "";
      const toolCalls: PendingToolCall[] = [];
      let failed = false;

      try {
        for await (const event of this.streamOnce(aiTools, signal)) {
          if (event.type === "text-delta") {
            text += event.text;
            yield event;
          } else if (event.type === "reasoning") {
            yield event;
          } else if (event.type === "tool-call") {
            toolCalls.push({ id: event.id, name: event.name, args: event.args });
            yield event;
          } else if (event.type === "error") {
            failed = true;
            yield event;
          } else {
            yield event;
          }
        }
      } catch (error) {
        // A user-initiated abort is a normal end of the turn, not an error.
        if (signal.aborted) return;
        yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }

      if (failed) return;

      const assistantMessage: CoreMessage = {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            args: call.args,
          })),
        ],
      };
      this.messages.push(assistantMessage);
      await this.persist(assistantMessage);

      if (toolCalls.length === 0) return;

      const answered = new Set<string>();
      try {
        for (const call of toolCalls) {
          if (signal.aborted) break;
          const result = await this.executeTool(call, signal);
          const toolMessage: CoreMessage = {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                result: result.content,
              },
            ],
          };
          this.messages.push(toolMessage);
          await this.persist(toolMessage);
          answered.add(call.id);
          yield {
            type: "tool-result",
            id: call.id,
            name: call.name,
            content: result.content,
            isError: result.isError,
          };
        }
      } finally {
        // The assistant message carrying these tool calls is already persisted,
        // so every call must be closed with a tool message even when execution
        // is aborted or blows up mid-batch; otherwise the stored history can
        // no longer be sent to the API.
        for (const call of toolCalls) {
          if (answered.has(call.id)) continue;
          const content = signal.aborted
            ? "Tool execution interrupted by user."
            : "Tool execution interrupted before a result was produced.";
          const synthetic: CoreMessage = {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                result: content,
              },
            ],
          };
          this.messages.push(synthetic);
          await this.persist(synthetic).catch(() => {});
          yield { type: "tool-result", id: call.id, name: call.name, content, isError: true };
        }
      }

      if (signal.aborted) return;
    }

    yield {
      type: "error",
      error: new Error(`Max steps (${config.maxSteps}) reached, stopping.`),
    };
  }

  private async applyCompactionSummary(compacted: CompactionResult): Promise<CoreMessage[]> {
    const { config, model } = this.opts;
    if (config.contextCompaction !== "summary" || !model) {
      return compacted.messages;
    }
    const headCount = compacted.messages[0]?.role === "system" ? 1 : 0;
    const dropped = this.messages.slice(headCount, headCount + compacted.droppedCount);
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

  private async *streamOnce(
    aiTools: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const { streamChat } = await import("../llm/stream");
    yield* streamChat({
      model: this.opts.model,
      messages: this.messages,
      tools: aiTools,
      abortSignal: signal,
    });
  }

  private buildAiTools(): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const t of this.opts.registry.list()) {
      tools[t.name] = aiTool({
        description: t.description,
        parameters: t.parameters as never,
      });
    }
    return tools;
  }

  private async executeTool(call: PendingToolCall, signal: AbortSignal): Promise<ToolResult> {
    const { registry, config, cwd } = this.opts;
    const tool = registry.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    const decision = checkPermission(
      config.permissionMode,
      { toolName: call.name, args: call.args, level: tool.permission },
      { cwd },
      config.permissions.allow,
    );

    if (decision === "deny") {
      return { content: `Permission denied for tool "${call.name}".`, isError: true };
    }
    if (decision === "ask") {
      let approved = false;
      try {
        approved = this.confirmHandler
          ? await this.confirmHandler({
              toolName: call.name,
              args: call.args,
              level: tool.permission,
            })
          : false;
      } catch {
        approved = false;
      }
      if (!approved) {
        return { content: `User rejected tool "${call.name}".`, isError: true };
      }
    }

    const parsed = tool.parameters.safeParse(call.args);
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true };
    }

    try {
      return await tool.execute(parsed.data, { cwd, abortSignal: signal });
    } catch (error) {
      if (signal.aborted) {
        return { content: "Tool execution aborted.", isError: true };
      }
      return {
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
