import { type LanguageModel, tool as aiTool, generateText } from "ai";
import type { StarConfig } from "../config/schema";
import { type CompactionResult, compactMessages, summarizeMessages } from "../context/compaction";
import type { StreamEvent } from "../core/events";
import { formatGitSummary, getGitSummary } from "../core/git";
import {
  type ChatInput,
  type CoreMessage,
  reconcileToolCalls,
  retractLastTurn,
} from "../core/messages";
import { type HookEvent, type HookRunResult, runHooks } from "../hooks/runner";
import { checkPermission } from "../permissions/gate";
import type { PermissionRequest } from "../permissions/types";
import type { SessionStore } from "../session/store";
import { scheduleSessionTitle } from "../session/title";
import { beginTurn, currentTurnSeq, setSnapshotHooks } from "../tools/fs/snapshots";
import type { ToolRegistry } from "../tools/registry";
import { pendingTodoTitles } from "../tools/todo";
import type { ToolResult } from "../tools/types";
import { readProjectMemory } from "./project-memory";
import { createSkillTool, discoverSkills, formatSkillsBlock } from "./skills";
import { MAX_SUBAGENT_DEPTH, createSubagentTool } from "./subagent";
import { createRememberTool, readUserMemory } from "./user-memory";

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  config: StarConfig;
  cwd: string;
  system?: string;
  sessionStore?: SessionStore | null;
  // Effective context window for compaction (per-model override resolved by
  // the caller); falls back to config.contextMaxTokens when omitted.
  contextMaxTokens?: number;
  // Depth of this loop in the subagent chain (0 = main agent). At
  // MAX_SUBAGENT_DEPTH the subagent tool is not registered, so subagents
  // cannot spawn further subagents.
  subagentDepth?: number;
  // Base delay between stream retries (doubled per attempt); tests shrink it.
  retryDelayMs?: number;
}

export const PLAN_MODE_PROMPT =
  "\n\nYou are currently in PLAN MODE. Research the task using only the read-only tools available to you, then present a concrete, step-by-step implementation plan as your final answer. You must not modify files, run shell commands, or otherwise change the system — write/exec tools are unavailable in this mode. Do not ask the user to run commands for you; note manual steps in the plan instead. The user will review your plan and approve it before any execution begins.";

interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

// Matches announcements of pending work ("我会保留…", "接下来我将…",
// "开始执行转换…", "I will now convert…") in a text-only reply — the signature
// of a model that ended its turn without doing what it just said it would do.
// Keyword matching can never catch every phrasing, so this is only the first
// line of defense: a text-only reply to a nudge is re-nudged unconditionally.
const PENDING_WORK_PATTERN =
  /(?:我将|我会|我现在|接下来|下一步|下面(?:我|将)|稍后|随后|准备开始|现在开始|马上|即将|这就|待会|开始(?:执行|进行|处理|转换|动手|生成|写入|运行|创建)|(?:完成后|然后|接着)会|让我(?:们)?(?:来)?|I will|I'll|I am going to|I'm going to|I shall|let me|next,? I|I will now)/i;

const AUTO_CONTINUE_NUDGE =
  "[auto-continue] You ended your turn with words instead of actions. Do not describe or restate the plan — continue the task NOW by calling tools. Reply with text only if the task is already fully complete.";

const COMPLETION_CHECK_TIMEOUT_MS = 30_000;

// Keyword matching cannot catch every phrasing of "I am about to…", so a
// text-only end to a turn that used tools gets a semantic check: the model
// itself judges whether the user's request is actually finished. Returns
// null when the check fails (network, timeout, unparseable reply) — the
// caller then treats the turn as complete rather than nudging on a broken
// signal.
async function checkTaskComplete(
  model: LanguageModel,
  request: string,
  finalReply: string,
  signal: AbortSignal,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPLETION_CHECK_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const { text } = await generateText({
      model,
      maxTokens: 8,
      abortSignal: controller.signal,
      prompt: [
        "An AI coding agent was given this task by the user:",
        `<task>\n${request.slice(0, 2000)}\n</task>`,
        "The agent has stopped calling tools and ended with this reply:",
        `<reply>\n${finalReply.slice(0, 2000)}\n</reply>`,
        "Has the agent fully completed the task — every requested action actually performed — or is it only describing, planning, or reporting progress with work still left? Answer with exactly one word: DONE or NOT_DONE.",
      ].join("\n"),
    });
    const verdict = text.trim().toUpperCase();
    if (verdict.startsWith("NOT_DONE")) return false;
    if (verdict.startsWith("DONE")) return true;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

const STREAM_RETRY_BASE_DELAY_MS = 1000;

// Client/validation failures will fail again identically, so only transient
// conditions merit another attempt: rate limits, server errors, and
// network/parse failures without a status.
const NON_RETRYABLE_ERROR_NAMES = new Set([
  "AI_NoSuchToolError",
  "AI_InvalidToolArgumentsError",
  "AI_InvalidPromptError",
  "AI_NoSuchModelError",
  "AI_LoadAPIKeyError",
]);

function isRetryableStreamError(error: Error): boolean {
  if (NON_RETRYABLE_ERROR_NAMES.has(error.name)) return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }
  return true;
}

// Resolves true after `ms`, or false immediately when the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      this.bindSnapshotHooks(opts.sessionStore);
    }
    // Read-level, so it is available at every subagent depth and in plan
    // mode. Skills are discovered lazily at execute time, so ones added
    // mid-session work without re-registering.
    opts.registry?.register(createSkillTool({ cwd: opts.cwd }));
    // Write-level like the fs write tools, so the permission gate still
    // applies in ask mode; available at every subagent depth.
    opts.registry?.register(createRememberTool());
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

  // Swaps the persistence target (/new starts a fresh session mid-REPL).
  // Title generation is re-armed so the new session gets one after its first
  // turn, and snapshot checkpoints now flow to the new store.
  setSessionStore(store: SessionStore | null): void {
    this.opts.sessionStore = store;
    this.titleScheduled = false;
    if (store) this.bindSnapshotHooks(store);
  }

  private bindSnapshotHooks(store: SessionStore): void {
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
    input: ChatInput,
    signal: AbortSignal,
    opts?: { persistAs?: string },
  ): AsyncGenerator<StreamEvent> {
    this.syncSystemMessage();

    const inputText = typeof input === "string" ? input : input.text;
    const images = typeof input === "string" ? [] : input.images;
    const userMessage: CoreMessage =
      images.length > 0
        ? {
            role: "user",
            content: [
              ...images.map((img) => ({
                type: "image" as const,
                image: img.data,
                mimeType: img.mimeType,
              })),
              { type: "text" as const, text: inputText },
            ],
          }
        : { role: "user", content: inputText };
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
    let autoContinues = 0;
    let lastWasNudge = false;
    let usedToolsThisTurn = false;
    // Open items from the latest todo_write this turn — a deterministic
    // "work still pending" signal that needs no text interpretation.
    let openTodos: string[] = [];

    for (let step = 0; step < config.maxSteps; step++) {
      const maxTokens = this.opts.contextMaxTokens ?? config.contextMaxTokens;
      const compacted = compactMessages([...this.messages], maxTokens);
      if (compacted.compacted) {
        this.messages = await this.applyCompactionSummary(compacted);
      }

      // One model step, with retries: a transient stream failure (network
      // error, 429/5xx, idle watchdog cutoff) or an empty response must not
      // silently end a half-finished turn. Partial output from a failed
      // attempt is discarded — only a clean attempt is persisted.
      const maxRetries = Math.max(0, config.streamMaxRetries);
      const baseDelay = this.opts.retryDelayMs ?? STREAM_RETRY_BASE_DELAY_MS;
      let text = "";
      const toolCalls: PendingToolCall[] = [];
      let failure: Error | null = null;

      for (let attempt = 0; ; attempt++) {
        text = "";
        toolCalls.length = 0;
        failure = null;
        let finishReason: string | undefined;
        // Retried attempts get more patient stream timeouts (1x, 2x, 3x): a
        // relay that just timed out is overloaded, so re-asking with the same
        // deadline would hit the same wall.
        const timeoutScale = Math.min(attempt + 1, 3);

        try {
          for await (const event of this.streamOnce(aiTools, signal, timeoutScale)) {
            if (event.type === "text-delta") {
              text += event.text;
              yield event;
            } else if (event.type === "reasoning") {
              yield event;
            } else if (event.type === "tool-call") {
              toolCalls.push({ id: event.id, name: event.name, args: event.args });
              yield event;
            } else if (event.type === "finish") {
              finishReason = event.finishReason;
              yield event;
            } else if (event.type === "error") {
              // Held back until retries are exhausted, so the UI shows retry
              // notices instead of an error for a turn that then recovers.
              failure = event.error;
            } else {
              yield event;
            }
          }
        } catch (error) {
          // A user-initiated abort is a normal end of the turn, not an error.
          if (signal.aborted) return;
          failure = error instanceof Error ? error : new Error(String(error));
        }

        if (signal.aborted) return;
        if (!failure && (text.length > 0 || toolCalls.length > 0)) break;
        if (failure && !isRetryableStreamError(failure)) break;
        if (attempt >= maxRetries) break;

        yield {
          type: "retry",
          attempt: attempt + 2,
          maxAttempts: maxRetries + 1,
          reason: failure ? failure.message : `empty response (finish: ${finishReason ?? "none"})`,
        };
        if (!(await sleep(baseDelay * 2 ** attempt, signal))) return;
      }

      if (failure) {
        yield { type: "error", error: failure };
        return;
      }
      if (text.length === 0 && toolCalls.length === 0) {
        yield {
          type: "error",
          error: new Error("The model returned an empty response after retries; ending the turn."),
        };
        return;
      }

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
      this.maybeScheduleTitle(text);

      if (toolCalls.length === 0) {
        // A turn that ends in text only is suspect: weaker models announce
        // work ("我会…") instead of calling tools. Escalating signals decide
        // whether to nudge the model onward (bounded by maxAutoContinues,
        // never in plan mode, where a text-only plan is the intended end):
        // open todo items written this turn (deterministic), an ignored
        // previous nudge (behavioral), announcement keywords (heuristic),
        // and finally a semantic completion check by the model itself for
        // turns that used tools but match no keyword.
        let reason: string | null = null;
        let nudgeText = AUTO_CONTINUE_NUDGE;
        if (openTodos.length > 0) {
          reason = `${openTodos.length} todo item(s) still open`;
          nudgeText = `[auto-continue] You ended your turn with unfinished todo item(s): ${openTodos
            .map((t) => `"${t}"`)
            .join(
              ", ",
            )}. Complete them now with tool calls, or update the list with todo_write if they are no longer needed.`;
        } else if (lastWasNudge) {
          reason = "reply still had no tool calls";
        } else if (PENDING_WORK_PATTERN.test(text)) {
          reason = "reply announced unfinished work";
        } else if (usedToolsThisTurn && !signal.aborted) {
          const complete = await checkTaskComplete(this.opts.model, inputText, text, signal);
          if (complete === false) reason = "completion check reports the task unfinished";
        }
        if (
          reason !== null &&
          config.permissionMode !== "plan" &&
          autoContinues < config.maxAutoContinues
        ) {
          autoContinues++;
          lastWasNudge = true;
          yield {
            type: "notice",
            message: `${reason}; asking the model to continue (${autoContinues}/${config.maxAutoContinues}).`,
          };
          const nudge: CoreMessage = { role: "user", content: nudgeText };
          this.messages.push(nudge);
          await this.persist(nudge);
          continue;
        }
        await this.runEventHooks("Stop");
        return;
      }
      lastWasNudge = false;
      usedToolsThisTurn = true;

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
          if (call.name === "todo_write" && !result.isError) {
            openTodos = pendingTodoTitles(call.args);
          }
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
  // Project memory (AGENTS.md in the cwd) and user memory (~/.star-cli/
  // MEMORY.md) are appended as delimited blocks; both cache by mtime, so this
  // stays cheap per turn. The
  // skills listing is refreshed here as well, so skills added mid-session
  // show up in the next turn's system prompt.
  private syncSystemMessage(): void {
    const base = this.opts.system;
    const plan = this.opts.config.permissionMode === "plan";
    const parts: string[] = [];
    if (base) parts.push(base);
    if (plan) parts.push(PLAN_MODE_PROMPT.trim());
    const memory = readProjectMemory(this.opts.cwd);
    if (memory) parts.push(memory);
    const userMemory = readUserMemory();
    if (userMemory) parts.push(userMemory);
    const skills = discoverSkills(this.opts.cwd);
    if (skills.length > 0) parts.push(formatSkillsBlock(skills));
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
    timeoutScale = 1,
  ): AsyncGenerator<StreamEvent> {
    const { streamChat } = await import("../llm/stream");
    yield* streamChat({
      model: this.opts.model,
      messages: this.messages,
      tools: aiTools,
      abortSignal: signal,
      idleTimeoutMs: this.opts.config.streamIdleTimeoutSec * 1000 * timeoutScale,
      firstPartTimeoutMs: this.opts.config.streamFirstChunkTimeoutSec * 1000 * timeoutScale,
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
      config.permissions.deny,
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
