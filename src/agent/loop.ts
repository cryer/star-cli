import type { LanguageModel } from "ai";
import { tool as aiTool } from "ai";
import type { StarConfig } from "../config/schema";
import { type CompactionResult, compactMessages, summarizeMessages } from "../context/compaction";
import type { StreamEvent } from "../core/events";
import { formatGitSummary, getGitSummary } from "../core/git";
import { type CoreMessage, reconcileToolCalls, retractLastTurn } from "../core/messages";
import { type HookEvent, type HookRunResult, runHooks } from "../hooks/runner";
import { checkPermission } from "../permissions/gate";
import type { PermissionRequest } from "../permissions/types";
import type { SessionStore } from "../session/store";
import { scheduleSessionTitle } from "../session/title";
import { beginTurn, currentTurnSeq, setSnapshotHooks } from "../tools/fs/snapshots";
import type { ToolRegistry } from "../tools/registry";
import type { ToolResult } from "../tools/types";
import { MAX_SUBAGENT_DEPTH, createSubagentTool } from "./subagent";

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  config: StarConfig;
  cwd: string;
  system?: string;
  sessionStore?: SessionStore | null;
  // Depth of this loop in the subagent chain (0 = main agent). At
  // MAX_SUBAGENT_DEPTH the subagent tool is not registered, so subagents
  // cannot spawn further subagents.
  subagentDepth?: number;
}

export const PLAN_MODE_PROMPT =
  "\n\nYou are currently in PLAN MODE. Research the task using only the read-only tools available to you, then present a concrete, step-by-step implementation plan as your final answer. You must not modify files, run shell commands, or otherwise change the system — write/exec tools are unavailable in this mode. Do not ask the user to run commands for you; note manual steps in the plan instead. The user will review your plan and approve it before any execution begins.";

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
  private titleScheduled = false;
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;
  // Hook failures never block the turn (except an explicit PreToolUse block);
  // their stderr surfaces through this callback (REPL system message / stderr
  // in print mode).
  onHookWarning?: (message: string) => void;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    if (opts.system) {
      this.messages.push({ role: "system", content: opts.system });
    }
    if (opts.sessionStore) {
      const store = opts.sessionStore;
      setSnapshotHooks({
        onPush: (snapshot) =>
          store.appendCheckpoint(
            {
              id: snapshot.id,
              timestamp: snapshot.timestamp,
              path: snapshot.path,
              existed: snapshot.existed,
              toolName: snapshot.toolName,
              turn: snapshot.turn,
              messageIndex: snapshot.messageIndex,
            },
            snapshot.content,
          ),
        onRemove: (ids) => store.removeCheckpoints(ids),
      });
    }
    const depth = opts.subagentDepth ?? 0;
    if (opts.registry && depth < MAX_SUBAGENT_DEPTH) {
      opts.registry.register(
        createSubagentTool({
          model: opts.model,
          config: opts.config,
          cwd: opts.cwd,
          system: opts.system,
          depth,
          getConfirmHandler: () => this.confirmHandler,
        }),
      );
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

  // Cut point for a rewind: messages[index] should be the user message that
  // started the rewound turn, but compaction may have shifted indices, so
  // walk back to the nearest user message. Never touches a leading system
  // message.
  private retractionCut(index: number): number {
    const clamped = Math.max(0, Math.min(index, this.messages.length - 1));
    for (let i = clamped; i >= 0; i--) {
      if (this.messages[i]?.role === "user") return i;
    }
    return this.messages[0]?.role === "system" ? 1 : 0;
  }

  countRetraction(index: number): number {
    return this.messages.length - this.retractionCut(index);
  }

  // Truncates the history back to the given message index (the user message
  // at that index and everything after it is dropped) and persists the
  // trimmed history, so /rewind stays consistent across resume.
  async retractFromIndex(index: number): Promise<number> {
    const cut = this.retractionCut(index);
    const removed = this.messages.length - cut;
    if (removed === 0) return 0;
    this.messages = this.messages.slice(0, cut);
    await this.opts.sessionStore?.replaceMessages([...this.messages]);
    this.turnMarkers = this.turnMarkers.filter((m) => m.userIndex < cut);
    return removed;
  }

  async appendContextMessage(text: string, role: "user" | "system" = "user"): Promise<void> {
    const message: CoreMessage = { role, content: text };
    this.messages.push(message);
    await this.persist(message);
  }

  private async persist(message: CoreMessage): Promise<void> {
    await this.opts.sessionStore?.append(message);
  }

  // After the first assistant reply, kick off background title generation
  // for the session. Runs once per loop; the store-level title check makes
  // resumed sessions that already have a title a no-op.
  private maybeScheduleTitle(input: string): void {
    if (this.titleScheduled) return;
    const store = this.opts.sessionStore;
    if (!store) return;
    this.titleScheduled = true;
    scheduleSessionTitle(store, input, this.opts.model);
  }

  async *stream(
    input: string,
    signal: AbortSignal,
    opts?: { persistAs?: string },
  ): AsyncGenerator<StreamEvent> {
    this.syncSystemMessage();

    const userMessage: CoreMessage = { role: "user", content: input };
    this.messages.push(userMessage);
    // Only the root loop opens a new snapshot turn: a subagent runs inside the
    // parent's turn, and its file changes must keep the parent's turn seq and
    // message index so /undo and /rewind attribute them correctly.
    const seq =
      (this.opts.subagentDepth ?? 0) === 0 ? beginTurn(this.messages.length - 1) : currentTurnSeq();
    this.turnMarkers.push({ seq, userIndex: this.messages.length - 1 });
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
      this.maybeScheduleTitle(input);

      if (toolCalls.length === 0) {
        await this.runEventHooks("Stop");
        return;
      }

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

  // The permission mode can change at runtime, so the system message is
  // recomputed at the start of every turn instead of being frozen by the
  // constructor. Also restores a system message after loadMessages() (resume,
  // /model switch) replaced the history with one that has none. Git context
  // (branch, dirty count, recent commits) is refreshed here too, so the model
  // always sees the current repo state; any git failure is silently skipped.
  private syncSystemMessage(): void {
    const base = this.opts.system;
    const plan = this.opts.config.permissionMode === "plan";
    const parts: string[] = [];
    if (base) parts.push(base);
    if (plan) parts.push(PLAN_MODE_PROMPT.trim());
    const git = getGitSummary(this.opts.cwd);
    if (git) parts.push(formatGitSummary(git));
    if (parts.length === 0) return;
    const content = parts.join("\n\n");
    const head = this.messages[0];
    if (head?.role === "system" && typeof head.content === "string") {
      if (head.content !== content) head.content = content;
    } else if (head?.role !== "system") {
      this.messages.unshift({ role: "system", content });
    }
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
      idleTimeoutMs: this.opts.config.streamIdleTimeoutSec * 1000,
    });
  }

  private buildAiTools(): Record<string, unknown> {
    const plan = this.opts.config.permissionMode === "plan";
    const tools: Record<string, unknown> = {};
    for (const t of this.opts.registry.list()) {
      // Plan mode hides write/exec tools from the model entirely; the
      // permission gate stays as a backstop for anything still attempted.
      if (plan && t.permission !== "read") continue;
      tools[t.name] = aiTool({
        description: t.description,
        parameters: t.parameters as never,
      });
    }
    return tools;
  }

  private async runEventHooks(
    event: HookEvent,
    toolName?: string,
    toolInput?: unknown,
  ): Promise<HookRunResult> {
    const empty: HookRunResult = { blocked: false, warnings: [] };
    if (this.opts.config.hooks.length === 0) return empty;
    try {
      const result = await runHooks(event, this.opts.config.hooks, {
        cwd: this.opts.cwd,
        sessionId: this.opts.sessionStore?.id,
        toolName,
        toolInput,
      });
      for (const warning of result.warnings) this.onHookWarning?.(warning);
      return result;
    } catch {
      // Hooks are best-effort by design: a broken hook must never crash a turn.
      return empty;
    }
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

    const pre = await this.runEventHooks("PreToolUse", call.name, call.args);
    if (pre.blocked) {
      return {
        content: `Tool "${call.name}" blocked by a PreToolUse hook: ${pre.reason}`,
        isError: true,
      };
    }

    let result: ToolResult;
    try {
      result = await tool.execute(parsed.data, { cwd, abortSignal: signal });
    } catch (error) {
      if (signal.aborted) {
        return { content: "Tool execution aborted.", isError: true };
      }
      return {
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    if (!result.isError) {
      await this.runEventHooks("PostToolUse", call.name, call.args);
    }
    return result;
  }
}
