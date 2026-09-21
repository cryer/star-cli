import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLoop } from "../agent/loop";
import { addAllowRule, savePermissionMode } from "../config/save";
import type { StarConfig } from "../config/schema";
import { estimateTokens } from "../context/tokens";
import { getGitSummary } from "../core/git";
import type { CoreMessage, ImageInput } from "../core/messages";
import { createModel } from "../llm/provider";
import { listModels } from "../llm/registry";
import { buildAllowRule, isAllowedByRules } from "../permissions/allow";
import type { PermissionRequest } from "../permissions/types";
import { loadSessionSnapshots } from "../session/checkpoints";
import { clearSessions } from "../session/clear";
import { formatSessionEntries, listSessionEntries, resolveSessionId } from "../session/list";
import { resumeSession } from "../session/resume";
import { SessionStore } from "../session/store";
import { collectUsageStats, formatUsageDashboard } from "../session/usage";
import { formatTaskFinished, formatTaskList, formatTaskStarted } from "../tasks/format";
import { type TaskSnapshot, defaultTaskManager } from "../tasks/manager";
import { TodoStore, createDefaultRegistry } from "../tools";
import {
  clearSnapshots,
  hydrateSnapshots,
  listSnapshots,
  rewindToSnapshot,
  undoTurnSnapshots,
} from "../tools/fs/snapshots";
import { formatTodos } from "../tools/todo";
import { VERSION } from "../version";
import type { ChatBackend } from "./backend";
import { budgetState } from "./budget";
import { copyText, readClipboardImage } from "./clipboard";
import { compactSession, exportSession } from "./commands/actions";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerCustomCommands } from "./commands/custom";
import { formatDoctorReport, runDoctor } from "./commands/doctor";
import { initProject } from "./commands/init-project";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { formatCheckpointList, planRewind } from "./commands/rewind";
import { type ExitPlanDecision, ExitPlanPrompt } from "./components/ExitPlanPrompt";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { type PermissionDecision, PermissionPrompt } from "./components/PermissionPrompt";
import { RewindConfirmPrompt, type RewindDecision } from "./components/RewindConfirmPrompt";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";
import {
  THOUGHT_SUMMARY_LENGTH,
  ThinkingIndicator,
  truncateTail,
} from "./components/ThinkingIndicator";
import { type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { computeCostUsd, estimateCost, formatDollars } from "./cost";
import { type DiffPreview, generateDiffPreview } from "./diff-preview";
import { isDoubleEscape } from "./double-esc";
import {
  buildDisplayMessages,
  coreMessageText,
  formatStreamError,
  splitCommittableLines,
  summarizeArgs,
} from "./format";
import { resolveMentions } from "./mentions";
import { notifyBell } from "./notify";
import { PromptQueue, type QueuedPrompt } from "./queue";
import { executeShellBang } from "./shell-bang";
import { type FlushState, nextFlush, startTicker } from "./ticker";
import { checkForUpdate } from "./update-check";

// Matches ansi-escapes' clearTerminal (Ink pulls the same sequence for its
// own full redraws): erase screen + scrollback, cursor home.
const CLEAR_TERMINAL =
  process.platform === "win32" ? "\u001B[2J\u001B[0f" : "\u001B[2J\u001B[3J\u001B[H";

export interface UsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function emptyUsage(): UsageStats {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function runningTaskLabels(): string[] {
  return defaultTaskManager
    .list()
    .filter((t) => t.status === "running")
    .map((t) => t.description ?? t.command);
}

// Shift+Tab cycles these in order; yolo is reachable only via /permission.
const SESSION_MODE_CYCLE = ["ask", "auto", "readonly", "plan"] as const;

function formatUsage(usage: UsageStats): string {
  return `API usage this session: ${usage.requests} requests, ${usage.promptTokens} prompt + ${usage.completionTokens} completion = ${usage.totalTokens} tokens`;
}

interface PendingPermission {
  request: PermissionRequest;
  preview: DiffPreview | null;
  resolve: (approved: boolean) => void;
}

interface PendingRewind {
  summary: string;
  resolve: (confirmed: boolean) => void;
}

interface ReplProps {
  backend: ChatBackend;
  model: string;
  permissionMode: string;
  config: StarConfig;
  cwd: string;
  sessionStore: SessionStore | null;
  initialMessages?: CoreMessage[];
  initialUsage?: UsageStats;
}

export function Repl({
  backend,
  model,
  permissionMode,
  config,
  cwd,
  sessionStore,
  initialMessages,
  initialUsage,
}: ReplProps) {
  const { exit } = useApp();
  const [initialDisplay] = useState(() => buildDisplayMessages(initialMessages ?? []));
  const [messages, setMessages] = useState<DisplayMessage[]>(initialDisplay);
  const [epoch, setEpoch] = useState(0);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState("");
  const [thoughtSummary, setThoughtSummary] = useState<string | null>(null);
  // usageVersion bump counter: the value is never read; setting it re-renders
  // so usageRef contents flow into StatusBar.
  const [, setUsageVersion] = useState(0);
  const [modelName, setModelName] = useState(model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [bgLabels, setBgLabels] = useState<string[]>(() => runningTaskLabels());
  const [permissionModeState, setPermissionModeState] = useState(permissionMode);
  const [planApproval, setPlanApprovalState] = useState(false);
  const [pendingRewind, setPendingRewindState] = useState<PendingRewind | null>(null);

  const backendRef = useRef<ChatBackend>(backend);
  const nextIdRef = useRef(initialDisplay.length);
  const abortRef = useRef<AbortController | null>(null);
  const streamedRef = useRef("");
  const thinkingRef = useRef(false);
  const reasoningRef = useRef("");
  const tickerStopRef = useRef<(() => void) | null>(null);
  const flushedRef = useRef<FlushState>({ streamed: "", reasoning: "" });
  const toolCardsRef = useRef(new Map<string, ToolCardData>());
  const pendingRef = useRef<PendingPermission | null>(null);
  const alwaysAllowedRef = useRef(new Set<string>());
  // Mode the session was in before plan mode was entered; restored on plan
  // approval or /plan toggle. null when plan mode is not active.
  const prevModeRef = useRef<StarConfig["permissionMode"] | null>(null);
  const planApprovalRef = useRef(false);
  const pendingRewindRef = useRef<PendingRewind | null>(null);
  const modelNameRef = useRef(model);
  // Live session store: /new swaps it mid-session, so callbacks must go
  // through the ref rather than the prop captured at mount.
  const sessionStoreRef = useRef<SessionStore | null>(sessionStore);
  const usageRef = useRef<UsageStats>(initialUsage ? { ...initialUsage } : emptyUsage());
  // Number of assistant chunks already committed to static history this turn;
  // 0 means the next streamed text still needs the "star" header.
  const turnChunksRef = useRef(0);
  // Mirror of `messages` for code that needs the current list synchronously
  // (e.g. computing the /undo cut point before redrawing).
  const messagesRef = useRef<DisplayMessage[]>(initialDisplay);

  const [queueItems, setQueueItems] = useState<QueuedPrompt[]>([]);
  const queueRef = useRef(new PromptQueue());
  // Clipboard images staged via Alt+V (or Ctrl+V where the terminal passes it
  // through), merged into the next submitted prompt.
  const [pendingImages, setPendingImages] = useState<{ id: number; image: ImageInput }[]>([]);
  const pendingImagesRef = useRef<{ id: number; image: ImageInput }[]>([]);
  const imageSeqRef = useRef(1);
  const [inputRefill, setInputRefill] = useState<{ text: string; seq: number } | undefined>();
  const refillSeqRef = useRef(0);
  // Timestamp of the last idle Esc; a second one within the window restores
  // the last user message for editing.
  const lastEscRef = useRef<number | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const budgetWarnedRef = useRef(false);
  const budgetExceededRef = useRef(false);
  // Latest runStream, so a finishing turn can drain the queue by re-entering
  // it without a circular useCallback dependency.
  const runStreamRef = useRef<((text: string, images?: ImageInput[]) => Promise<void>) | null>(
    null,
  );

  const pushMessage = useCallback(
    (role: DisplayMessage["role"], text: string, note?: string, tight?: boolean) => {
      setMessages((prev) => {
        const next = [...prev, { id: nextIdRef.current++, role, text, note, tight }];
        messagesRef.current = next;
        return next;
      });
    },
    [],
  );

  // Replace the whole history and remount the list (fresh Static instance).
  const applyMessages = useCallback((next: DisplayMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
    setEpoch((e) => e + 1);
  }, []);

  // Ink's <Static> can only append — dropping items from state does not erase
  // them from the terminal. Clear the screen first, then let the remounted
  // Static rewrite the surviving history.
  const redrawMessages = useCallback(
    (next: DisplayMessage[]) => {
      if (process.stdout.isTTY) {
        process.stdout.write(CLEAR_TERMINAL);
      }
      applyMessages(next);
    },
    [applyMessages],
  );

  const pushAssistantChunk = useCallback(
    (text: string, tight: boolean) => {
      const role: DisplayMessage["role"] =
        turnChunksRef.current === 0 ? "assistant" : "assistant-cont";
      turnChunksRef.current += 1;
      pushMessage(role, text, undefined, tight);
    },
    [pushMessage],
  );

  const setPendingPermission = useCallback((p: PendingPermission | null) => {
    pendingRef.current = p;
    setPending(p);
  }, []);

  const setPlanApproval = useCallback((v: boolean) => {
    planApprovalRef.current = v;
    setPlanApprovalState(v);
  }, []);

  const setPendingRewind = useCallback((p: PendingRewind | null) => {
    pendingRewindRef.current = p;
    setPendingRewindState(p);
  }, []);

  const stageClipboardImage = useCallback((img: ImageInput) => {
    pendingImagesRef.current = [
      ...pendingImagesRef.current,
      { id: imageSeqRef.current++, image: img },
    ];
    setPendingImages(pendingImagesRef.current);
  }, []);

  const clearPendingImages = useCallback(() => {
    pendingImagesRef.current = [];
    setPendingImages([]);
  }, []);

  // Numeric session cost (USD) from the accumulated usage; null when the
  // active model has no pricing configured.
  const sessionCostUsd = useCallback(
    () =>
      computeCostUsd(
        usageRef.current,
        config.models.find((m) => m.name === modelNameRef.current),
      ),
    [config],
  );

  const handlePasteImage = useCallback(() => {
    void readClipboardImage().then((img) => {
      if (img) stageClipboardImage(img);
    });
  }, [stageClipboardImage]);

  const handleRewindDecision = useCallback(
    (decision: RewindDecision) => {
      const p = pendingRewindRef.current;
      if (!p) return;
      setPendingRewind(null);
      p.resolve(decision === "yes");
    },
    [setPendingRewind],
  );

  // Session-scoped mode switch: mutates the shared config object the AgentLoop
  // reads on every tool call. Entering plan mode remembers the previous mode
  // for later restoration; unlike /permission nothing is written to config.
  const applySessionMode = useCallback(
    (mode: StarConfig["permissionMode"]) => {
      if (mode === config.permissionMode) return;
      if (mode === "plan") {
        prevModeRef.current = config.permissionMode;
      } else if (config.permissionMode === "plan") {
        prevModeRef.current = null;
      }
      config.permissionMode = mode;
      setPermissionModeState(mode);
    },
    [config],
  );

  const attachConfirmHandler = useCallback(
    (target: ChatBackend) => {
      target.confirmHandler = async (req) => {
        if (isAllowedByRules([...alwaysAllowedRef.current], req)) {
          return true;
        }
        const preview = await generateDiffPreview(req.toolName, req.args, cwd).catch(() => null);
        return new Promise<boolean>((resolve) => {
          setPendingPermission({ request: req, preview, resolve });
        });
      };
      target.onHookWarning = (message) => pushMessage("system", message);
    },
    [setPendingPermission, cwd, pushMessage],
  );

  useEffect(() => {
    attachConfirmHandler(backendRef.current);
    return () => {
      tickerStopRef.current?.();
      abortRef.current?.abort();
      pendingRef.current?.resolve(false);
    };
  }, [attachConfirmHandler]);

  useEffect(() => {
    if (process.env.STAR_NO_UPDATE_CHECK === "1") return;
    void checkForUpdate(VERSION).then((message) => {
      if (message) pushMessage("system", message);
    });
  }, [pushMessage]);

  useEffect(() => {
    const onUpdate = (task: TaskSnapshot) => {
      setBgLabels(runningTaskLabels());
      pushMessage(
        "system",
        task.status === "running" ? formatTaskStarted(task) : formatTaskFinished(task),
      );
      // Background tasks are exactly the case where the user has looked away.
      if (task.status !== "running") {
        notifyBell({
          enabled: config.notifyBell,
          thresholdSec: config.notifyBellThresholdSec,
          noNotifyEnv: process.env.STAR_NO_NOTIFY === "1",
        });
      }
    };
    defaultTaskManager.on("update", onUpdate);
    return () => {
      defaultTaskManager.off("update", onUpdate);
      defaultTaskManager.cleanup();
    };
  }, [pushMessage, config]);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    const p = pendingRef.current;
    if (p) {
      setPendingPermission(null);
      p.resolve(false);
    }
    const cleared = queueRef.current.clear();
    if (cleared.length > 0) {
      setQueueItems([]);
      pushMessage("system", `cleared ${cleared.length} queued message(s)`);
    }
  }, [setPendingPermission, pushMessage]);

  // Double-Esc while idle: retract the last user turn and put the originally
  // typed text back into the input for editing.
  const editLastMessage = useCallback(async () => {
    const current = backendRef.current;
    if (typeof current.retractLastTurn !== "function") return;
    const visible = messagesRef.current;
    let cut = -1;
    let text = "";
    for (let i = visible.length - 1; i >= 0; i--) {
      const msg = visible[i];
      if (msg?.role === "user") {
        cut = i;
        text = msg.text;
        break;
      }
    }
    if (cut < 0) return;
    const { removed } = await current.retractLastTurn();
    if (removed === 0) return;
    redrawMessages(visible.slice(0, cut));
    refillSeqRef.current += 1;
    setInputRefill({ text, seq: refillSeqRef.current });
    pushMessage("system", "last message restored for editing");
  }, [pushMessage, redrawMessages]);

  const handleExit = useCallback(() => {
    const killed = defaultTaskManager.cleanup();
    if (killed.length > 0) {
      pushMessage(
        "system",
        `Stopped ${killed.length} background task(s): ${killed.map((t) => t.id).join(", ")}`,
      );
    }
    exit();
  }, [exit, pushMessage]);

  useInput((_input, key) => {
    if (key.escape) {
      const busy =
        abortRef.current !== null ||
        pendingRef.current !== null ||
        planApprovalRef.current ||
        pendingRewindRef.current !== null;
      if (busy) {
        lastEscRef.current = null;
        interrupt();
        return;
      }
      const now = Date.now();
      if (isDoubleEscape(lastEscRef.current, now)) {
        lastEscRef.current = null;
        void editLastMessage();
      } else {
        lastEscRef.current = now;
      }
      return;
    }
    lastEscRef.current = null;
    if (key.shift && key.tab) {
      // Don't yank the mode out from under a running turn or an open prompt.
      if (
        abortRef.current ||
        pendingRef.current ||
        planApprovalRef.current ||
        pendingRewindRef.current
      )
        return;
      const current = config.permissionMode as (typeof SESSION_MODE_CYCLE)[number];
      const index = SESSION_MODE_CYCLE.indexOf(current);
      const next = SESSION_MODE_CYCLE[(index + 1) % SESSION_MODE_CYCLE.length] ?? "ask";
      applySessionMode(next);
    }
  });

  const handleDecision = useCallback(
    (decision: PermissionDecision) => {
      const p = pendingRef.current;
      if (!p) return;
      if (decision === "always") {
        const rule = buildAllowRule(p.request);
        alwaysAllowedRef.current.add(rule);
        void addAllowRule(rule)
          .then((added) => {
            pushMessage(
              "system",
              added
                ? `Always allow ${rule} — saved to config`
                : `Always allow ${rule} (already in config)`,
            );
          })
          .catch(() => {
            pushMessage("system", `Always allow ${rule} for this session (failed to save)`);
          });
      }
      setPendingPermission(null);
      p.resolve(decision !== "no");
    },
    [setPendingPermission, pushMessage],
  );

  const switchModel = useCallback(
    async (name: string): Promise<string> => {
      try {
        const newModel = createModel(config, name);
        const loop = new AgentLoop({
          model: newModel,
          registry: createDefaultRegistry(),
          config,
          cwd,
          sessionStore: sessionStoreRef.current,
        });
        const prev = backendRef.current;
        if (prev instanceof AgentLoop) {
          await loop.loadMessages([...prev.getMessages()]);
        }
        attachConfirmHandler(loop);
        backendRef.current = loop;
        modelNameRef.current = name;
        setModelName(name);
        return `Switched to model "${name}".`;
      } catch (error) {
        return `Failed to switch model: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    [config, cwd, attachConfirmHandler],
  );

  const resume = useCallback(
    async (id: string): Promise<string> => {
      const current = backendRef.current;
      if (!(current instanceof AgentLoop)) {
        return "Current backend does not support resuming sessions.";
      }
      const resolvedId = await resolveSessionId(id);
      if (!resolvedId) {
        return `Session not found: ${id}`;
      }
      const resumed = await resumeSession(resolvedId);
      if (!resumed) {
        return `Session not found: ${id}`;
      }
      await current.loadMessages(resumed.messages);
      const store = await SessionStore.open(resolvedId);
      if (store) {
        hydrateSnapshots(await loadSessionSnapshots(store.dir));
      }
      const display = buildDisplayMessages(resumed.messages);
      nextIdRef.current = display.length;
      applyMessages(display);
      usageRef.current = resumed.meta.usage ? { ...resumed.meta.usage } : emptyUsage();
      setUsageVersion((v) => v + 1);
      return `Resumed session ${resolvedId} (${resumed.messages.length} messages).`;
    },
    [applyMessages],
  );

  const runStream = useCallback(
    async (input: string, extraImages: ImageInput[] = []) => {
      const resolved = await resolveMentions(input, cwd);
      const images = [...resolved.images, ...extraImages];
      pushMessage(
        "user",
        input,
        resolved.attached.length + extraImages.length > 0
          ? `attached: ${[...resolved.attached, ...extraImages.map((img) => img.path)].join(", ")}`
          : undefined,
      );
      for (const skip of resolved.skipped) {
        pushMessage("system", `Skipped @${skip.path}: ${skip.reason}`);
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const turnStartedAt = Date.now();
      streamedRef.current = "";
      thinkingRef.current = true;
      reasoningRef.current = "";
      turnChunksRef.current = 0;
      setThinking(true);
      setThinkingText("");
      setThoughtSummary(null);
      setStreamingText("");
      setIsStreaming(true);
      flushedRef.current = { streamed: "", reasoning: "" };
      // Move the current streaming buffer into static history. Used at tool-call
      // boundaries (to keep chronological order) and by the ticker for long
      // answers, so the live redraw area — and with it the visible flicker —
      // stays small no matter how long the answer gets.
      const commitStreamed = (tight: boolean) => {
        if (streamedRef.current.length === 0) return;
        pushAssistantChunk(streamedRef.current, tight);
        streamedRef.current = "";
        flushedRef.current = { ...flushedRef.current, streamed: "" };
        setStreamingText("");
      };
      tickerStopRef.current = startTicker((tick) => {
        setSpinnerTick(tick);
        const split = splitCommittableLines(streamedRef.current, 8);
        if (split) {
          pushAssistantChunk(split.committed, true);
          streamedRef.current = split.rest;
          flushedRef.current = { ...flushedRef.current, streamed: "" };
        }
        const next: FlushState = {
          streamed: streamedRef.current,
          reasoning: reasoningRef.current,
        };
        if (nextFlush(flushedRef.current, next) !== null) {
          flushedRef.current = next;
          setStreamingText(next.streamed);
          setThinkingText(next.reasoning);
        }
      });
      try {
        for await (const event of backendRef.current.stream(
          images.length > 0 ? { text: resolved.input, images } : resolved.input,
          controller.signal,
          {
            persistAs:
              extraImages.length > 0
                ? `${input}${" [clipboard image]".repeat(extraImages.length)}`
                : input,
          },
        )) {
          if (event.type === "text-delta") {
            if (thinkingRef.current) {
              thinkingRef.current = false;
              setThinking(false);
              if (reasoningRef.current.length > 0) {
                setThoughtSummary(
                  `thought: ${truncateTail(reasoningRef.current, THOUGHT_SUMMARY_LENGTH)}`,
                );
              }
            }
            streamedRef.current += event.text;
          } else if (event.type === "reasoning") {
            reasoningRef.current += event.text;
          } else if (event.type === "tool-call") {
            // Flush the text spoken before this call into history first, so the
            // card lands in chronological order instead of after the whole turn.
            commitStreamed(true);
            toolCardsRef.current.set(event.id, {
              id: event.id,
              name: event.name,
              argsSummary: summarizeArgs(event.args),
            });
            setActivity(`running ${event.name}: ${summarizeArgs(event.args, 60)}`);
          } else if (event.type === "tool-result") {
            const card = toolCardsRef.current.get(event.id) ?? {
              id: event.id,
              name: event.name,
              argsSummary: "",
            };
            toolCardsRef.current.delete(event.id);
            // Rendered once, straight into static history — no live card region
            // that would have to be erased (and could linger) at turn end.
            pushMessage(
              "tool",
              formatToolCard({
                ...card,
                result: event.content,
                isError: event.isError ?? false,
              }),
            );
            setActivity(null);
            thinkingRef.current = true;
            reasoningRef.current = "";
            setThinking(true);
            setThinkingText("");
          } else if (event.type === "finish") {
            if (event.usage) {
              const usage = usageRef.current;
              usage.requests += 1;
              usage.promptTokens += event.usage.promptTokens;
              usage.completionTokens += event.usage.completionTokens;
              usage.totalTokens += event.usage.totalTokens;
              setUsageVersion((v) => v + 1);
              sessionStoreRef.current?.addUsage(event.usage).catch(() => {});
            }
          } else if (event.type === "error") {
            pushMessage("system", `Error: ${formatStreamError(event.error)}`);
          }
        }
      } catch (error) {
        const aborted =
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        if (!aborted) {
          pushMessage(
            "system",
            `Error: ${error instanceof Error ? formatStreamError(error) : String(error)}`,
          );
        }
      } finally {
        tickerStopRef.current?.();
        tickerStopRef.current = null;
        abortRef.current = null;
        setIsStreaming(false);
        thinkingRef.current = false;
        reasoningRef.current = "";
        setThinking(false);
        setThinkingText("");
        setThoughtSummary(null);
        setActivity(null);
        const finalText = streamedRef.current;
        streamedRef.current = "";
        setStreamingText(null);
        const interrupted = controller.signal.aborted;
        notifyBell({
          enabled: config.notifyBell,
          thresholdSec: config.notifyBellThresholdSec,
          noNotifyEnv: process.env.STAR_NO_NOTIFY === "1",
          interrupted,
          elapsedMs: Date.now() - turnStartedAt,
        });
        if (finalText.length > 0) {
          pushAssistantChunk(`${finalText}${interrupted ? " [interrupted]" : ""}`, false);
        } else if (interrupted && turnChunksRef.current > 0) {
          pushAssistantChunk("[interrupted]", false);
        }
        // Cards whose result event never arrived (e.g. hard abort) still get
        // flushed so no call vanishes from the transcript.
        for (const card of toolCardsRef.current.values()) {
          pushMessage("tool", formatToolCard(card));
        }
        toolCardsRef.current.clear();
        turnChunksRef.current = 0;
        const p = pendingRef.current;
        if (p) {
          setPendingPermission(null);
          p.resolve(false);
        }
        // A plan-mode turn that ran to completion ends in a plan, not in
        // changes — offer to approve it and switch back to execution.
        if (!interrupted && config.permissionMode === "plan") {
          setPlanApproval(true);
        }
        // Session budget (sessionBudgetUsd): warn once at 80%, error + block
        // further prompts at 100%. Unevaluable without per-model pricing.
        const cost = sessionCostUsd();
        const budget = config.sessionBudgetUsd;
        const status = budgetState(cost, budget);
        if (status === "warn" && !budgetWarnedRef.current) {
          budgetWarnedRef.current = true;
          pushMessage(
            "system",
            `Session cost $${formatDollars(cost ?? 0)} has passed 80% of the $${formatDollars(budget ?? 0)} session budget (sessionBudgetUsd).`,
          );
        }
        if (status === "exceeded" && !budgetExceededRef.current) {
          budgetExceededRef.current = true;
          pushMessage(
            "system",
            `Session budget exceeded: $${formatDollars(cost ?? 0)} of $${formatDollars(budget ?? 0)} (sessionBudgetUsd). New prompts are blocked — raise sessionBudgetUsd in the config or start a /new session.`,
          );
        }
        // Typeahead queue: send the next queued prompt FIFO once this turn is
        // fully done (permission prompts included). A crossed budget drops the
        // queue instead.
        const nextPrompt = queueRef.current.dequeue();
        if (nextPrompt) {
          if (status === "exceeded") {
            const dropped = queueRef.current.clear().length + 1;
            setQueueItems([]);
            pushMessage(
              "system",
              `Dropped ${dropped} queued message(s) — session budget exceeded.`,
            );
          } else {
            setQueueItems(queueRef.current.list());
            void runStreamRef.current?.(nextPrompt.text, nextPrompt.images);
          }
        }
      }
    },
    [
      pushMessage,
      pushAssistantChunk,
      setPendingPermission,
      setPlanApproval,
      cwd,
      config,
      sessionCostUsd,
    ],
  );

  useEffect(() => {
    runStreamRef.current = runStream;
  }, [runStream]);

  const handlePlanDecision = useCallback(
    (decision: ExitPlanDecision) => {
      setPlanApproval(false);
      if (decision === "no") return;
      const restore = prevModeRef.current ?? "ask";
      applySessionMode(restore);
      pushMessage("system", `Plan approved — permission mode restored to ${restore}.`);
      void runStream("The plan above is approved. Proceed with the implementation.");
    },
    [applySessionMode, pushMessage, runStream, setPlanApproval],
  );

  const registry = useMemo(() => {
    const ctx: CommandContext = {
      cwd,
      addSystemMessage: (text) => pushMessage("system", text),
      showDiff: (text, lines, note) => {
        setMessages((prev) => {
          const next = [
            ...prev,
            { id: nextIdRef.current++, role: "system" as const, text, note, diff: lines },
          ];
          messagesRef.current = next;
          return next;
        });
      },
      clearMessages: () => {
        redrawMessages([]);
      },
      conversationText: (scope) => {
        const current = backendRef.current;
        if (!(current instanceof AgentLoop)) return null;
        const messages = current.getMessages();
        if (scope === "all") {
          const parts = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => coreMessageText(m))
            .filter((text) => text.length > 0);
          return parts.length > 0 ? parts.join("\n\n") : null;
        }
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message?.role === "assistant") {
            const text = coreMessageText(message);
            if (text) return text;
          }
        }
        return null;
      },
      copyToClipboard: (text) => copyText(text),
      exit: () => handleExit(),
      listModels: () => {
        const models = listModels(config);
        if (models.length === 0) return "No models configured.";
        const lines = models.map(
          (m) =>
            `${m.name === modelNameRef.current ? "*" : " "} ${m.name} (${m.provider}/${m.model})`,
        );
        return `Models (* = current):\n${lines.join("\n")}`;
      },
      switchModel,
      listSessions: async (all) => {
        const entries = await listSessionEntries(all ? undefined : cwd);
        if (entries.length === 0) {
          return all ? "No sessions found." : "No sessions found for this directory.";
        }
        return formatSessionEntries(entries, { showCwd: all });
      },
      resumeSession: resume,
      newSession: async () => {
        const current = backendRef.current;
        if (!(current instanceof AgentLoop)) {
          return "Current backend does not support starting a new session.";
        }
        const store = await SessionStore.create(cwd, modelNameRef.current);
        current.setSessionStore(store);
        sessionStoreRef.current = store;
        // Keep the leading system prompt, drop everything else.
        const [first] = current.getMessages();
        await current.loadMessages(first?.role === "system" ? [first] : []);
        clearSnapshots();
        redrawMessages([]);
        usageRef.current = emptyUsage();
        budgetWarnedRef.current = false;
        budgetExceededRef.current = false;
        setUsageVersion((v) => v + 1);
        return `Started a new session (${store.id}) with a clean context.`;
      },
      clearSessions: async (all) => {
        const currentId = sessionStoreRef.current?.id;
        const removed = await clearSessions(all ? undefined : cwd, currentId);
        if (removed === 0) {
          return all ? "No stored sessions to delete." : "No stored sessions for this directory.";
        }
        const scope = all ? "across all directories" : "for this directory";
        const kept = currentId ? " The current session is still active." : "";
        return `Deleted ${removed} session(s) ${scope}.${kept}`;
      },
      showTodos: async () => {
        const store = new TodoStore();
        await store.load(cwd);
        return formatTodos(store.list());
      },
      listTasks: () => formatTaskList(defaultTaskManager.list()),
      showUsage: () => {
        const modelConfig = config.models.find((m) => m.name === modelNameRef.current);
        return `${formatUsage(usageRef.current)}\n${estimateCost(usageRef.current, modelNameRef.current, modelConfig)}`;
      },
      showGlobalUsage: async () => formatUsageDashboard(await collectUsageStats(), config.models),
      compactContext: async () => {
        let summaryModel = null;
        try {
          summaryModel = createModel(config, modelNameRef.current);
        } catch {
          summaryModel = null;
        }
        const result = await compactSession({
          backend: backendRef.current,
          sessionStore: sessionStoreRef.current,
          config,
          model: summaryModel,
        });
        if (result.compacted && result.messages) {
          const display = buildDisplayMessages(result.messages);
          nextIdRef.current = display.length;
          applyMessages(display);
        }
        return result.message;
      },
      exportSession: (arg) =>
        exportSession({
          backend: backendRef.current,
          sessionStore: sessionStoreRef.current,
          cwd,
          arg,
        }),
      undo: async () => {
        const current = backendRef.current;
        if (!(current instanceof AgentLoop)) {
          return "Nothing to undo.";
        }
        // Turn-scoped undo: retract the last turn's messages, and revert file
        // changes only when they provably belong to that same turn.
        const { removed, turn } = await current.retractLastTurn();
        if (removed === 0) {
          return "Nothing to undo (no conversation turn to retract).";
        }
        const reverted = turn !== undefined ? await undoTurnSnapshots(turn) : [];
        // Mirror the retraction on screen: drop the last prompt and everything
        // the turn produced (answer chunks, tool cards, notifications). Static
        // output cannot be edited in place, so the surviving history is
        // redrawn from a cleared screen.
        const visible = messagesRef.current;
        let cut = -1;
        for (let i = visible.length - 1; i >= 0; i--) {
          if (visible[i]?.role === "user") {
            cut = i;
            break;
          }
        }
        redrawMessages(cut >= 0 ? visible.slice(0, cut) : visible);
        return [...reverted, `Retracted the last conversation turn (${removed} messages).`].join(
          "\n",
        );
      },
      rewind: async (args) => {
        if (!args) {
          return formatCheckpointList(listSnapshots(), cwd);
        }
        const id = Number.parseInt(args, 10);
        if (!Number.isFinite(id) || String(id) !== args) {
          return `Usage: /rewind <n> — "${args}" is not a checkpoint number.`;
        }
        const plan = planRewind(listSnapshots(), id);
        if (!plan) {
          return `Checkpoint #${id} not found (it may already have been rewound). /rewind lists the current checkpoints.`;
        }
        const current = backendRef.current;
        const messageCount =
          plan.messageIndex !== null && current instanceof AgentLoop
            ? current.countRetraction(plan.messageIndex)
            : 0;
        // Rewinds are destructive: confirm before touching files or history.
        const confirmed = await new Promise<boolean>((resolve) => {
          setPendingRewind({
            summary: `Rewind to just before checkpoint #${id} (${plan.target.toolName} ${plan.target.path}):\n${plan.affected.length} file change(s) will be reverted, ${messageCount} message(s) retracted.`,
            resolve,
          });
        });
        if (!confirmed) {
          return "Rewind cancelled.";
        }
        const result = await rewindToSnapshot(id);
        if (!result) {
          return `Checkpoint #${id} is no longer available.`;
        }
        let retracted = 0;
        if (result.messageIndex !== null && current instanceof AgentLoop) {
          retracted = await current.retractFromIndex(result.messageIndex);
          if (retracted > 0) {
            const display = buildDisplayMessages([...current.getMessages()]);
            nextIdRef.current = display.length;
            redrawMessages(display);
          }
        }
        return [
          ...result.reverted,
          `Rewound to before checkpoint #${id}: ${result.reverted.length} file change(s) reverted, ${retracted} message(s) retracted.`,
        ].join("\n");
      },
      permissionMode: async (args) => {
        const current = config.permissionMode;
        if (!args) {
          const mark = (m: string) => (m === current ? "*" : " ");
          return [
            "Permission modes (* = current):",
            `${mark("ask")} ask      — reads allowed; writes/exec ask for confirmation`,
            `${mark("auto")} auto     — everything allowed except hard-denied dangerous commands/paths`,
            `${mark("readonly")} readonly — read-only; all writes/exec denied`,
            `${mark("yolo")} yolo     — allow everything, never ask (disables ALL safety checks)`,
          ].join("\n");
        }
        const mode = args.toLowerCase();
        if (!["ask", "auto", "readonly", "yolo"].includes(mode)) {
          return `Unknown permission mode: ${args} (expected ask | auto | readonly | yolo)`;
        }
        config.permissionMode = mode as StarConfig["permissionMode"];
        prevModeRef.current = null;
        setPermissionModeState(mode);
        await savePermissionMode(mode);
        return mode === "yolo"
          ? "Permission mode set to yolo — ALL safety checks disabled, tools run without asking. Saved to config."
          : `Permission mode set to ${mode}. Saved to config.`;
      },
      planMode: async () => {
        if (config.permissionMode === "plan") {
          const restore = prevModeRef.current ?? "ask";
          applySessionMode(restore);
          return `Exited plan mode — permission mode back to ${restore} (this session only).`;
        }
        applySessionMode("plan");
        return "Entered plan mode: the agent researches with read-only tools and presents a plan for approval before anything is executed. /plan again to exit.";
      },
      initProject: async (args) => {
        let model = null;
        try {
          model = createModel(config, modelNameRef.current);
        } catch {
          model = null;
        }
        const result = await initProject({ cwd, args, model });
        return result.message;
      },
      runDoctor: async () => formatDoctorReport(await runDoctor({ cwd, config })),
      submitPrompt: async (text) => {
        await runStream(text);
      },
      describeConfig: () =>
        [
          `defaultModel: ${config.defaultModel || "(none)"}`,
          `permissionMode: ${config.permissionMode}`,
          `providers (${config.providers.length}): ${config.providers.map((p) => p.name).join(", ") || "(none)"}`,
          `models (${config.models.length}): ${config.models.map((m) => m.name).join(", ") || "(none)"}`,
          `maxSteps: ${config.maxSteps}`,
          `contextMaxTokens: ${config.contextMaxTokens}`,
          `streamIdleTimeoutSec: ${config.streamIdleTimeoutSec}`,
          `permissions.allow (${config.permissions.allow.length}): ${config.permissions.allow.join(", ") || "(none)"}`,
          `hooks (${config.hooks.length}): ${config.hooks.map((h) => h.event).join(", ") || "(none)"}`,
        ].join("\n"),
    };
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    registerCustomCommands(reg, cwd);
    return Object.assign(reg, { ctx });
  }, [
    pushMessage,
    handleExit,
    config,
    cwd,
    switchModel,
    resume,
    runStream,
    applyMessages,
    redrawMessages,
    applySessionMode,
    setPendingRewind,
  ]);

  const runShellBang = useCallback(
    async (raw: string) => {
      pushMessage("user", `!${raw.trim()}`);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const outcome = await executeShellBang(raw, cwd, controller.signal);
        if (!outcome.ok) {
          pushMessage(
            "system",
            outcome.reason === "dangerous"
              ? `Refused to run dangerous command: ${raw.trim()}`
              : "Usage: !<command>",
          );
          return;
        }
        pushMessage(
          "tool",
          formatToolCard({
            id: `bang-${nextIdRef.current}`,
            name: "bash",
            argsSummary: outcome.command,
            result: outcome.output,
            isError: outcome.isError,
          }),
        );
        const current = backendRef.current;
        if (current instanceof AgentLoop) {
          await current.appendContextMessage(outcome.contextMessage);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [cwd, pushMessage],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith("!")) {
        // A bang would clobber the streaming turn's abort controller, so it
        // waits in the queue like a regular prompt.
        if (abortRef.current) {
          queueRef.current.enqueue({ text, images: [] });
          setQueueItems(queueRef.current.list());
          return;
        }
        void runShellBang(text.slice(1));
        return;
      }
      if (text.startsWith("/")) {
        const parsed = parseSlashCommand(text);
        if (!parsed) return;
        const command = registry.get(parsed.name);
        if (!command) {
          pushMessage("system", `Unknown command: /${parsed.name} (try /help)`);
          return;
        }
        void command.run(parsed.args, registry.ctx);
        return;
      }
      const budget = config.sessionBudgetUsd;
      if (budgetState(sessionCostUsd(), budget) === "exceeded") {
        pushMessage(
          "system",
          `Session budget of $${formatDollars(budget ?? 0)} (sessionBudgetUsd) is exceeded — prompts are blocked. Slash commands still work; raise sessionBudgetUsd in the config or start a /new session.`,
        );
        return;
      }
      const images = pendingImagesRef.current.map((staged) => staged.image);
      if (images.length > 0) clearPendingImages();
      if (abortRef.current) {
        queueRef.current.enqueue({ text, images });
        setQueueItems(queueRef.current.list());
        return;
      }
      void runStream(text, images);
    },
    [registry, pushMessage, runStream, runShellBang, config, clearPendingImages, sessionCostUsd],
  );

  const commandHints = useMemo(
    () => registry.list().map((cmd) => ({ name: cmd.name, description: cmd.description })),
    [registry],
  );

  // Expensive status-bar bits (sync git call, token estimate over the full
  // history) refresh on turn boundaries and history rewrites, not per tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isStreaming and epoch are deliberate refresh triggers, not values read inside
  useEffect(() => {
    setGitBranch(getGitSummary(cwd)?.branch ?? null);
    const current = backendRef.current;
    if (current instanceof AgentLoop) {
      setContextPercent(
        Math.round((estimateTokens([...current.getMessages()]) / config.contextMaxTokens) * 100),
      );
    } else {
      setContextPercent(null);
    }
  }, [cwd, config, isStreaming, epoch]);

  const sessionCost = sessionCostUsd();

  return (
    <Box flexDirection="column">
      <MessageList key={`messages-${epoch}`} messages={messages} />
      {(thinking || activity !== null) && (
        <ThinkingIndicator
          reasoning={thinkingText}
          frame={spinnerTick}
          activity={activity ?? undefined}
        />
      )}
      {!thinking && activity === null && thoughtSummary !== null && (
        <Text dimColor>{thoughtSummary}</Text>
      )}
      {streamingText !== null && (streamingText !== "" || turnChunksRef.current === 0) && (
        <StreamingMessage text={streamingText} continuation={turnChunksRef.current > 0} />
      )}
      {pending && (
        <PermissionPrompt
          request={pending.request}
          preview={pending.preview}
          onDecision={handleDecision}
        />
      )}
      {planApproval && <ExitPlanPrompt onDecision={handlePlanDecision} />}
      {pendingRewind && (
        <RewindConfirmPrompt summary={pendingRewind.summary} onDecision={handleRewindDecision} />
      )}
      {queueItems.map((item) => (
        <Text key={item.id} dimColor>
          queued: {item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text}
        </Text>
      ))}
      {pendingImages.map((staged) => (
        <Text key={staged.id} dimColor>
          [image attached: {staged.image.path}]
        </Text>
      ))}
      <InputBox
        isStreaming={isStreaming}
        disabled={pending !== null || planApproval || pendingRewind !== null}
        commands={commandHints}
        cwd={cwd}
        refill={inputRefill}
        onSubmit={handleSubmit}
        onInterrupt={interrupt}
        onExit={handleExit}
        onPasteImage={handlePasteImage}
      />
      <StatusBar
        cwd={cwd}
        model={modelName}
        permissionMode={permissionModeState}
        tokens={usageRef.current.totalTokens}
        gitBranch={gitBranch}
        contextPercent={contextPercent}
        sessionCostUsd={sessionCost}
        backgroundTasks={bgLabels}
      />
    </Box>
  );
}

export interface ReplOptions {
  model: string;
  permissionMode: string;
  config: StarConfig;
  cwd: string;
  sessionStore: SessionStore | null;
  initialMessages?: CoreMessage[];
  initialUsage?: UsageStats;
}

export function renderRepl(backend: ChatBackend, opts: ReplOptions) {
  // Backstop for abnormal exits: never leave orphaned background processes.
  process.on("exit", () => {
    defaultTaskManager.cleanup();
  });
  return render(
    <Repl
      backend={backend}
      model={opts.model}
      permissionMode={opts.permissionMode}
      config={opts.config}
      cwd={opts.cwd}
      sessionStore={opts.sessionStore}
      initialMessages={opts.initialMessages}
      initialUsage={opts.initialUsage}
    />,
  );
}
