import { type LanguageModel, tool as aiTool, generateText } from "ai";
import type { StarConfig } from "../config/schema";
import { type CompactionResult, compactMessages, summarizeMessages } from "../context/compaction";
import type { StreamEvent } from "../core/events";
import { formatGitSummary, getGitSummaryCached } from "../core/git";
import { isOversizedImageError, stripOversizedImages } from "../core/image";
import {
  type ChatInput,
  type CoreMessage,
  reconcileToolCalls,
  retractLastTurn,
} from "../core/messages";
import { type HookEvent, type HookRunResult, runHooks } from "../hooks/runner";
import { computeRetryDelayMs, isRetryableStreamError, summarizeStreamError } from "../llm/retry";
import { checkPermission } from "../permissions/gate";
import type { PermissionRequest } from "../permissions/types";
import type { SessionStore } from "../session/store";
import { scheduleSessionTitle } from "../session/title";
import { beginTurn, currentTurnSeq, setSnapshotHooks } from "../tools/fs/snapshots";
import { ToolRegistry } from "../tools/registry";
import { TodoStore, pendingTodoTitles, setTodoPersistGuard } from "../tools/todo";
import type { ToolResult } from "../tools/types";
import { defaultAgentTasks } from "./agent-tasks";
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

const EMPTY_REPLY_NUDGE =
  "[auto-continue] Your previous reply was empty — no text and no tool calls. If the task is fully complete, reply with one short confirmation; otherwise continue NOW by calling tools.";

// An empty reply the model finished with a content filter reproduces on every
// identical resend (the filter judged the request itself), so it gets one
// confirmation resend before steering changes the input. Any other empty
// finish — stop with no content, or no finish at all — is indistinguishable
// from a relay hiccup and gets the full retry budget first.
function isFilteredEmptyFinish(finishReason: string | undefined): boolean {
  return finishReason === "content-filter";
}

// After the retry budget is spent, an empty reply finished deliberately
// (stop/content-filter) is steered with a nudge; an empty finish of any other
// kind (idle-timeout, none) means the stream stayed sick and errors out.
function isSteerableEmptyFinish(finishReason: string | undefined): boolean {
  return finishReason === "stop" || finishReason === "content-filter";
}

// Appended to a nudge that spends the last continuation budget, so the model
// knows the next tool-less reply hands the turn back to the user instead of
// being nudged again — its cue to wrap up or report what remains.
function finalNudgeWarning(autoContinues: number, maxAutoContinues: number): string {
  return autoContinues >= maxAutoContinues
    ? " This is the final automatic continuation — if your next reply again has no tool calls, nudging stops and the turn is handed back to the user. Finish the work now or summarize what remains."
    : "";
}

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
        "Has the agent fully completed the task — every requested action actually performed, and the result verified by running a check (tests, build, or inspecting the produced output) rather than assumed? Or is it only describing, planning, or reporting progress with work still left? Answer with exactly one word: DONE or NOT_DONE.",
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

// Stable JSON for doom-loop signatures: object keys sort recursively so the
// same arguments serialize identically regardless of key order.
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
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
  // Doom-loop guard: signature of the most recent tool call and how many
  // times in a row it has repeated. Any different call resets the count.
  private lastToolSignature: string | null = null;
  private repeatedToolCalls = 0;
  // Turn context of the in-flight stream() turn, stamped onto every tool
  // execution so file snapshots attribute root changes to a turn and mark
  // subagent changes as excluded from turn-level retraction.
  private activeTurnSeq = 0;
  private activeTurnUserIndex = -1;
  private titleScheduled = false;
  private titleInput?: string;
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;
  // Hook failures never block the turn (except an explicit PreToolUse block);
  // their stderr surfaces through this callback (REPL system message / stderr
  // in print mode).
  onHookWarning?: (message: string) => void;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    const depth = opts.subagentDepth ?? 0;
    if (depth > 0) {
      // Subagent todo isolation: the default registry wires the todo tools to
      // a process-wide store, so a child's todo_write would clobber the root
      // session's list (and the REPL panel mirroring it). The child gets a
      // fresh registry backed by its own store — the registry a caller hands
      // to a subagent loop is always a freshly created default one (see
      // runSubagent), so replacing it loses nothing.
      opts.registry = new ToolRegistry(new TodoStore());
    } else {
      // Root only: todo persistence follows the permission mode, so
      // readonly/plan sessions never touch .star/todos.json. The mode can
      // change at runtime, so the guard reads the live config object.
      setTodoPersistGuard(() => {
        const mode = this.opts.config.permissionMode;
        return mode !== "readonly" && mode !== "plan";
      });
    }
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
    this.titleInput = undefined;
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
            owner: snapshot.owner,
            contentTooLarge: snapshot.contentTooLarge,
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

  // Read-only counterpart of retractLastTurn: how many messages /undo would
  // drop and which snapshot turn's file changes it would revert (undefined =
  // no verified turn, so no file snapshots may be reverted). Mutates nothing,
  // so the REPL can show the preview before the user confirms.
  previewLastTurnRetraction(): { removed: number; turn?: number } {
    const result = retractLastTurn([...this.messages]);
    if (result.removed === 0) return { removed: 0 };
    const userIndex = result.messages.length;
    const last = this.turnMarkers[this.turnMarkers.length - 1];
    const turn = last && last.userIndex === userIndex ? last.seq : undefined;
    return { removed: result.removed, turn };
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

  // Replaces oversized image parts in the in-memory history with text
  // placeholders and rewrites the persisted session, so the failed request
  // can be resent and a later resume never carries the offending images.
  private async stripOversizedImages(): Promise<number> {
    const { messages, removed } = stripOversizedImages(this.messages);
    if (removed === 0) return 0;
    this.messages = messages;
    await this.opts.sessionStore?.replaceMessages([...this.messages]);
    return removed;
  }

  // Background title generation runs once per loop, fed by the first real
  // user message of the session. It must NOT latch on the first assistant
  // step's text: that text is empty for a tool-call-only first step (the
  // common agentic case), which used to burn the one-shot flag on an empty
  // input and left every such session untitled. The store-level title check
  // makes resumed sessions that already have a title a no-op.
  private maybeScheduleTitle(): void {
    if (this.titleScheduled) return;
    const store = this.opts.sessionStore;
    if (!store) return;
    const input = this.titleInput;
    if (!input) return;
    this.titleScheduled = true;
    scheduleSessionTitle(store, input, this.opts.model);
  }

  // A user interrupt (Esc) ends the turn mid-stream, before the normal
  // assistant-message persistence runs. Whatever text and tool calls already
  // arrived are still persisted — the text marked with "[interrupted]" so the
  // cut-off stays visible after a resume and the model can tell its reply was
  // cut short — and streamed tool calls are closed with synthetic results so
  // the stored history stays valid for the API.
  private async *persistInterrupted(
    text: string,
    toolCalls: PendingToolCall[],
  ): AsyncGenerator<StreamEvent> {
    if (text.length === 0 && toolCalls.length === 0) return;
    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text: `${text} [interrupted]` }] : []),
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
    for (const call of toolCalls) {
      const content = "Tool execution interrupted by user.";
      const synthetic: CoreMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
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

  async *stream(
    input: ChatInput,
    signal: AbortSignal,
    opts?: { persistAs?: string },
  ): AsyncGenerator<StreamEvent> {
    this.syncSystemMessage();

    const inputText = typeof input === "string" ? input : input.text;
    const images = typeof input === "string" ? [] : input.images;
    if (this.titleInput === undefined && inputText.trim().length > 0) {
      this.titleInput = inputText;
    }
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
    this.activeTurnSeq = seq;
    this.activeTurnUserIndex = this.messages.length - 1;
    await this.persist(
      opts?.persistAs !== undefined ? { role: "user", content: opts.persistAs } : userMessage,
    );
    this.maybeScheduleTitle();

    const { config, registry, cwd } = this.opts;
    const aiTools = this.buildAiTools();
    let autoContinues = 0;
    let lastWasNudge = false;
    let usedToolsThisTurn = false;
    // Open items from the latest todo_write this turn — a deterministic
    // "work still pending" signal that needs no text interpretation.
    let openTodos: string[] = [];

    for (let step = 0; step < config.maxSteps; step++) {
      // Deliver finished background subagent reports at step boundaries so
      // the parent monitors its children without polling. Only the root
      // loop drains — children cannot spawn subagents.
      if ((this.opts.subagentDepth ?? 0) === 0) {
        for (const finished of defaultAgentTasks.drainNotifications()) {
          const label = finished.description ? ` "${finished.description}"` : "";
          const note: CoreMessage = {
            role: "user",
            content: `[background subagent ${finished.id}${label} ${finished.status}]\n${finished.result}`,
          };
          this.messages.push(note);
          await this.persist(note);
        }
      }
      const maxTokens = this.opts.contextMaxTokens ?? config.contextMaxTokens;
      const compacted = compactMessages([...this.messages], maxTokens);
      if (compacted.compacted) {
        this.messages = await this.applyCompactionSummary(compacted, signal);
        // Compaction rewrote the history wholesale, so recorded turn indices
        // no longer line up — drop the markers like loadMessages() does.
        // /undo then only retracts messages until new turns accumulate,
        // instead of reverting files against a stale snapshot turn.
        this.turnMarkers = [];
      }

      // One model step, with retries: a transient stream failure (network
      // error, 429/5xx, idle watchdog cutoff) or an empty response must not
      // silently end a half-finished turn. Partial output from a failed
      // attempt is discarded — only a clean attempt is persisted. The wait
      // between attempts honors the server's Retry-After hint and otherwise
      // backs off exponentially with jitter (see llm/retry.ts).
      const maxRetries = Math.max(0, config.streamMaxRetries);
      const baseDelay = this.opts.retryDelayMs ?? STREAM_RETRY_BASE_DELAY_MS;
      let text = "";
      const toolCalls: PendingToolCall[] = [];
      let failure: Error | null = null;
      // Finish reason of the latest attempt: distinguishes a model that
      // actively returned nothing (stop/content-filter — the same request
      // tends to fail again) from a stream that died empty (idle-timeout,
      // network — worth resending as-is).
      let lastFinishReason: string | undefined;
      // Token usage of the latest attempt, and whether it streamed any
      // reasoning: both mark an empty reply as *deliberate* generation
      // rather than a relay hiccup. Reasoning-model relays that hide
      // reasoning content return turns where the model thought but produced
      // no visible output as an empty stop that still bills completion
      // tokens — resending the identical request reproduces them, so they
      // are steered early instead of spending the full retry budget.
      let lastUsage: { completionTokens: number } | undefined;
      let sawReasoning = false;
      // One free retry per step, outside the transient-retry budget: when the
      // provider rejects the request for an oversized image (a 4xx), the
      // offending images are stripped from the history and the request resent.
      let oversizedImagesStripped = false;

      for (let attempt = 0; ; attempt++) {
        text = "";
        toolCalls.length = 0;
        failure = null;
        lastFinishReason = undefined;
        lastUsage = undefined;
        sawReasoning = false;
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
              sawReasoning = true;
              yield event;
            } else if (event.type === "tool-call") {
              toolCalls.push({ id: event.id, name: event.name, args: event.args });
              yield event;
            } else if (event.type === "finish") {
              lastFinishReason = event.finishReason;
              lastUsage = event.usage;
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
          if (!signal.aborted) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
        }

        if (signal.aborted) {
          yield* this.persistInterrupted(text, toolCalls);
          return;
        }
        if (!failure && (text.length > 0 || toolCalls.length > 0)) break;
        if (failure && !oversizedImagesStripped && isOversizedImageError(failure)) {
          oversizedImagesStripped = true;
          const removed = await this.stripOversizedImages();
          if (removed > 0) {
            yield {
              type: "notice",
              message: `Removed ${removed} oversized image(s) the model rejected; retrying the request.`,
            };
            continue;
          }
        }
        if (failure && !isRetryableStreamError(failure)) break;
        if (attempt >= maxRetries) break;
        // Deterministic-empty replies reproduce on identical resends, so
        // after one confirmation resend break out and let the steering logic
        // below change the model's input: a content filter judged the
        // request itself; reasoning arrived but no visible output; or the
        // finish billed completion tokens while nothing was delivered (the
        // signature of a reasoning-only turn on a relay that hides
        // reasoning). Any other empty reply — stop with no content and no
        // tokens — is indistinguishable from a relay hiccup (an overloaded
        // relay answers with an empty stub) and gets the full retry budget:
        // a resend bills the same prompt a nudge would, without polluting
        // the history.
        if (
          !failure &&
          text.length === 0 &&
          toolCalls.length === 0 &&
          attempt >= 1 &&
          (isFilteredEmptyFinish(lastFinishReason) ||
            sawReasoning ||
            (lastUsage !== undefined && lastUsage.completionTokens > 0))
        )
          break;

        const delayMs = computeRetryDelayMs(attempt, baseDelay, failure);
        yield {
          type: "retry",
          attempt: attempt + 2,
          maxAttempts: maxRetries + 1,
          delayMs,
          reason: failure
            ? summarizeStreamError(failure)
            : `empty response (finish: ${lastFinishReason ?? "none"})`,
        };
        if (!(await sleep(delayMs, signal))) {
          // An abort that lands during the retry wait is the same user
          // interrupt as Esc mid-stream: keep whatever this attempt already
          // produced instead of dropping it silently.
          yield* this.persistInterrupted(text, toolCalls);
          return;
        }
      }

      if (failure) {
        yield { type: "error", error: failure };
        return;
      }
      if (text.length === 0 && toolCalls.length === 0) {
        // Steering beats repeating: a nudge changes the model's input, which
        // breaks a deterministic empty reply where an identical resend would
        // not. Shares the auto-continue budget, so a model that keeps
        // answering with nothing still stops.
        if (
          isSteerableEmptyFinish(lastFinishReason) &&
          config.permissionMode !== "plan" &&
          autoContinues < config.maxAutoContinues
        ) {
          autoContinues++;
          lastWasNudge = true;
          yield {
            type: "notice",
            message: `the model returned an empty reply; asking the model to continue (${autoContinues}/${config.maxAutoContinues}).`,
          };
          const nudge: CoreMessage = {
            role: "user",
            content: EMPTY_REPLY_NUDGE + finalNudgeWarning(autoContinues, config.maxAutoContinues),
          };
          this.messages.push(nudge);
          await this.persist(nudge);
          continue;
        }
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
          const nudge: CoreMessage = {
            role: "user",
            content: nudgeText + finalNudgeWarning(autoContinues, config.maxAutoContinues),
          };
          this.messages.push(nudge);
          await this.persist(nudge);
          continue;
        }
        if (reason !== null && config.permissionMode !== "plan") {
          // Never stop silently with work pending: say why the turn is ending
          // and how to get it going again.
          yield {
            type: "notice",
            message: `${reason}; auto-continue limit reached, handing the turn back — reply "continue" to keep going.`,
          };
        }
        await this.runEventHooks("Stop");
        return;
      }
      lastWasNudge = false;
      usedToolsThisTurn = true;
      // Tool calls are real progress: the budget guards against *consecutive*
      // unproductive replies, so a working turn earns its nudges back and a
      // long productive task is no longer cut off mid-way.
      autoContinues = 0;

      const answered = new Set<string>();
      try {
        for (const call of toolCalls) {
          if (signal.aborted) break;
          // Doom-loop guard: the same tool called with identical arguments
          // over and over is a model stuck retrying, so past the threshold
          // the repeat is refused without executing. The refusal is persisted
          // as the call's result like any other, keeping history replayable.
          const refusal = this.doomLoopRefusal(call);
          if (refusal !== null) {
            yield { type: "notice", message: refusal };
          }
          const result =
            refusal !== null
              ? { content: refusal, isError: true }
              : await this.executeTool(call, signal);
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
    const git = getGitSummaryCached(this.opts.cwd);
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

  private async applyCompactionSummary(
    compacted: CompactionResult,
    signal?: AbortSignal,
  ): Promise<CoreMessage[]> {
    const { config, model } = this.opts;
    if (config.contextCompaction !== "summary" || !model) {
      return compacted.messages;
    }
    const headCount = compacted.messages[0]?.role === "system" ? 1 : 0;
    const dropped = this.messages.slice(headCount, headCount + compacted.droppedCount);
    try {
      const summary = await summarizeMessages(dropped, model, signal);
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
    for await (const event of streamChat({
      model: this.opts.model,
      messages: this.messages,
      tools: aiTools,
      abortSignal: signal,
      idleTimeoutMs: this.opts.config.streamIdleTimeoutSec * 1000 * timeoutScale,
      firstPartTimeoutMs: this.opts.config.streamFirstChunkTimeoutSec * 1000 * timeoutScale,
    })) {
      // The idle watchdog can end a stream gracefully after content already
      // arrived; surface the cut-off instead of letting a half sentence pass
      // for a complete reply.
      if (event.type === "finish" && event.truncated) {
        yield {
          type: "notice",
          message:
            "Response was cut short by the stream idle timeout — the reply may be incomplete.",
        };
      }
      yield event;
    }
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

  // opencode's doom_loop guard: returns a refusal once the identical tool
  // call (name + stable-serialized args) has repeated config.doomLoopThreshold
  // times in a row; 0 disables. Any different signature resets the streak.
  // Subagents are separate loop instances, so each counts its own streak.
  private doomLoopRefusal(call: PendingToolCall): string | null {
    const threshold = this.opts.config.doomLoopThreshold;
    if (threshold <= 0) return null;
    const signature = `${call.name} ${stableStringify(call.args)}`;
    if (signature === this.lastToolSignature) {
      this.repeatedToolCalls += 1;
    } else {
      this.lastToolSignature = signature;
      this.repeatedToolCalls = 1;
    }
    if (this.repeatedToolCalls < threshold) return null;
    return `Refused: tool "${call.name}" was called ${this.repeatedToolCalls} times in a row with identical arguments. Stop retrying it — change your approach or report that you are blocked.`;
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
      result = await tool.execute(parsed.data, {
        cwd,
        abortSignal: signal,
        snapshotContext: {
          owner: (this.opts.subagentDepth ?? 0) > 0 ? "subagent" : "root",
          turn: this.activeTurnSeq,
          messageIndex: this.activeTurnUserIndex,
        },
      });
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
