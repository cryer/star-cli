import { Box, Text, render, useApp } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentTaskSnapshot,
  defaultAgentTasks,
  formatAgentTaskUpdate,
} from "../agent/agent-tasks";
import { AgentLoop } from "../agent/loop";
import { globalConfigPath } from "../config/paths";
import { addAllowRule, savePermissionMode, saveReasoningEffort } from "../config/save";
import { type StarConfig, contextWindowTokens } from "../config/schema";
import { estimateTokens } from "../context/tokens";
import { getGitSummaryCached } from "../core/git";
import { MAX_IMAGE_DIMENSION } from "../core/image";
import type { CoreMessage, ImageInput } from "../core/messages";
import { createModel, reasoningEffortMetadata } from "../llm/provider";
import { listModels, resolveModelConfig } from "../llm/registry";
import { buildAllowRule, isAllowedByRules } from "../permissions/allow";
import type { PermissionRequest } from "../permissions/types";
import { loadSessionSnapshots } from "../session/checkpoints";
import { clearSessions } from "../session/clear";
import {
  formatSessionEntries,
  listSessionEntries,
  relativeTime,
  resolveSessionId,
  sessionPreview,
  shortSessionId,
} from "../session/list";
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
  listTurnSnapshots,
  rewindToSnapshot,
} from "../tools/fs/snapshots";
import { type TodoItem, formatTodos, loadTodos, parseTodoArgs, resetTodos } from "../tools/todo";
import { VERSION } from "../version";
import type { ChatBackend } from "./backend";
import { budgetState } from "./budget";
import {
  type CacheTotals,
  addToCacheTotals,
  cacheHitPercent,
  cacheUsageReported,
} from "./cache-stats";
import { copyText, readClipboardImage } from "./clipboard";
import { compactSession, exportSession } from "./commands/actions";
import { registerBuiltinCommands } from "./commands/builtin";
import {
  type ConnectAnswers,
  openConfigFile,
  saveConnection,
  saveDefaultModel,
} from "./commands/connect";
import { registerCustomCommands } from "./commands/custom";
import { formatDoctorReport, runDoctor } from "./commands/doctor";
import { initProject } from "./commands/init-project";
import { formatRedoResult, formatRedoSummary } from "./commands/redo";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { formatCheckpointList, planRewind } from "./commands/rewind";
import { didYouMeanSuffix } from "./commands/suggest";
import { buildUndoDiffs, buildUndoTreeDiffs } from "./commands/undo";
import { ConnectWizard } from "./components/ConnectWizard";
import { type ExitPlanDecision, ExitPlanPrompt } from "./components/ExitPlanPrompt";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { type PermissionDecision, PermissionPrompt } from "./components/PermissionPrompt";
import {
  type ConfirmDiff,
  RewindConfirmPrompt,
  type RewindDecision,
} from "./components/RewindConfirmPrompt";
import { type SelectOption, SelectPrompt } from "./components/SelectPrompt";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";
import {
  THOUGHT_SUMMARY_LENGTH,
  ThinkingIndicator,
  truncateTail,
} from "./components/ThinkingIndicator";
import { TodoPanel } from "./components/TodoPanel";
import { type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { computeCostUsd, estimateCost, formatDollars, formatTokens } from "./cost";
import { type DiffLine, type DiffPreview, generateDiffPreview } from "./diff-preview";
import { isDoubleEscape } from "./double-esc";
import {
  buildDisplayMessages,
  coreMessageText,
  formatByteCount,
  formatStreamError,
  splitCommittableLines,
  summarizeArgs,
} from "./format";
import { appendHistory, loadHistory } from "./history";
import { thinkingIcon, toolIcon } from "./icons";
import { resolveMentions } from "./mentions";
import { notifyBell } from "./notify";
import { PromptQueue, type QueuedPrompt } from "./queue";
import { executeShellBang } from "./shell-bang";
import { SYSTEM_PROMPT } from "./system-prompt";
import { toTerminalSafe } from "./terminal-text";
import { type FlushState, nextFlush, startTicker } from "./ticker";
import { checkForUpdate } from "./update-check";
import { useInput } from "./use-input";

// Matches ansi-escapes' clearTerminal (Ink pulls the same sequence for its
// own full redraws): erase screen + scrollback, cursor home.
const CLEAR_TERMINAL =
  process.platform === "win32" ? "\u001B[2J\u001B[0f" : "\u001B[2J\u001B[3J\u001B[H";

export interface UsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Prompt-cache totals; absent until a provider reports cache fields.
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
  cache?: CacheTotals;
}

function emptyUsage(): UsageStats {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function runningTaskLabels(): string[] {
  const shells = defaultTaskManager
    .list()
    .filter((t) => t.status === "running")
    .map((t) => t.description ?? t.command);
  const agents = defaultAgentTasks
    .list()
    .filter((t) => t.status === "running")
    .map((t) => t.description ?? t.id);
  return [...shells, ...agents];
}

// Shift+Tab cycles these in order; yolo is reachable only via /permission.
const SESSION_MODE_CYCLE = ["ask", "auto", "readonly", "plan"] as const;

// Commands that rewrite the conversation, the persistence target, or files:
// running them mid-turn would corrupt the session underneath the active loop,
// so they are refused while a turn streams. Read-only commands are unaffected.
// Exported for tests.
export const BUSY_BLOCKED_COMMANDS = new Set([
  "new",
  "resume",
  "undo",
  "redo",
  "rewind",
  "compact",
  "fork",
  "clear-sessions",
  "model",
  "connect",
  "memory",
]);

function formatUsage(usage: UsageStats): string {
  return `API usage this session: ${usage.requests} requests, ${formatTokens(usage.promptTokens)} prompt + ${formatTokens(usage.completionTokens)} completion = ${formatTokens(usage.totalTokens)} tokens`;
}

interface PendingPermission {
  request: PermissionRequest;
  preview: DiffPreview | null;
  resolve: (approved: boolean) => void;
}

interface PendingRewind {
  summary: string;
  title?: string;
  confirmLabel?: string;
  diffs?: ConfirmDiff[];
  resolve: (confirmed: boolean) => void;
}

interface PendingPicker {
  title: string;
  options: SelectOption[];
  resolve: (value: string | null) => void;
}

interface PendingConnect {
  resolve: (message: string) => void;
}

const SESSION_PICKER_CAP = 20;

// First-user-message previews are trimmed to a single ~60-char line in the
// resume picker description.
const SESSION_PREVIEW_MAX = 60;

// Queued typeahead entries rendered in the live region: a bounded count so
// the live region can never grow to terminal height (see TodoPanel).
const MAX_VISIBLE_QUEUED = 5;

// Reasoning-effort presets offered by the /model follow-up picker. Level
// naming is not standardized across models (some add none/xhigh...), so the
// config accepts any string and a custom value already set on the model is
// appended to this list.
const REASONING_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "max"];

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
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [permissionModeState, setPermissionModeState] = useState(permissionMode);
  const [planApproval, setPlanApprovalState] = useState(false);
  const [pendingRewind, setPendingRewindState] = useState<PendingRewind | null>(null);
  const [picker, setPickerState] = useState<PendingPicker | null>(null);
  const [pendingConnect, setPendingConnectState] = useState<PendingConnect | null>(null);

  const backendRef = useRef<ChatBackend>(backend);
  const nextIdRef = useRef(initialDisplay.length);
  const abortRef = useRef<AbortController | null>(null);
  // Name of a long-running slash command currently in flight (only /compact
  // for now): prompts queue and session-rewriting commands are refused just
  // like during a stream — /compact ends with backend.loadMessages(), which
  // would clobber any turn that ran concurrently with it.
  const busyCommandRef = useRef<string | null>(null);
  const streamedRef = useRef("");
  const turnStartedAtRef = useRef(0);
  // Chars of streamedRef already committed to static history by the ticker.
  // The live region renders only the suffix past this point, and a stream
  // retry rolls the buffer back to it (the resend re-streams from scratch).
  const lastCommittedLenRef = useRef(0);
  const thinkingRef = useRef(false);
  const reasoningRef = useRef("");
  const tickerStopRef = useRef<(() => void) | null>(null);
  const flushedRef = useRef<FlushState>({ streamed: "", reasoning: "" });
  const toolCardsRef = useRef(new Map<string, ToolCardData>());
  const pendingRef = useRef<PendingPermission | null>(null);
  // Promise chain serializing permission prompts: a background subagent's
  // request queues behind the open prompt instead of overwriting its resolve
  // (the single pending slot can only hold one request at a time).
  const permissionChainRef = useRef<Promise<void>>(Promise.resolve());
  const alwaysAllowedRef = useRef(new Set<string>());
  // Mode the session was in before plan mode was entered; restored on plan
  // approval or /plan toggle. null when plan mode is not active.
  const prevModeRef = useRef<StarConfig["permissionMode"] | null>(null);
  const planApprovalRef = useRef(false);
  const pendingRewindRef = useRef<PendingRewind | null>(null);
  const pickerRef = useRef<PendingPicker | null>(null);
  const pendingConnectRef = useRef<PendingConnect | null>(null);
  const modelNameRef = useRef(model);
  // Live session store: /new swaps it mid-session, so callbacks must go
  // through the ref rather than the prop captured at mount.
  const sessionStoreRef = useRef<SessionStore | null>(sessionStore);
  // Latest config for mount-only listeners (a new config object identity must
  // not re-register — and thereby kill — the background-task listeners).
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
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
  // Persistent input history, loaded once per process (STAR_HOME is fixed).
  const [initialHistory] = useState(() => loadHistory());
  const budgetWarnedRef = useRef(false);
  const budgetExceededRef = useRef(false);
  // Latest runStream, so a finishing turn can drain the queue by re-entering
  // it without a circular useCallback dependency.
  const runStreamRef = useRef<((text: string, images?: ImageInput[]) => Promise<void>) | null>(
    null,
  );

  const pushMessage = useCallback(
    (
      role: DisplayMessage["role"],
      text: string,
      note?: string,
      tight?: boolean,
      interrupted?: boolean,
      diff?: DiffLine[],
    ) => {
      setMessages((prev) => {
        const next = [
          ...prev,
          { id: nextIdRef.current++, role, text, note, tight, interrupted, diff },
        ];
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
    (text: string, tight: boolean, interrupted = false) => {
      const role: DisplayMessage["role"] =
        turnChunksRef.current === 0 ? "assistant" : "assistant-cont";
      turnChunksRef.current += 1;
      pushMessage(role, text, undefined, tight, interrupted);
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

  const setPicker = useCallback((p: PendingPicker | null) => {
    pickerRef.current = p;
    setPickerState(p);
  }, []);

  const setPendingConnect = useCallback((p: PendingConnect | null) => {
    pendingConnectRef.current = p;
    setPendingConnectState(p);
  }, []);

  // One picker at a time; a second request while one is open resolves null
  // immediately so callers never hang.
  const showPicker = useCallback(
    (title: string, options: SelectOption[]): Promise<string | null> => {
      if (pickerRef.current) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        setPicker({ title, options, resolve });
      });
    },
    [setPicker],
  );

  const handlePickerSelect = useCallback(
    (value: string) => {
      const p = pickerRef.current;
      if (!p) return;
      setPicker(null);
      p.resolve(value);
    },
    [setPicker],
  );

  const handlePickerCancel = useCallback(() => {
    const p = pickerRef.current;
    if (!p) return;
    setPicker(null);
    p.resolve(null);
  }, [setPicker]);

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
    void readClipboardImage().then((result) => {
      if (!result) return;
      if (result.oversized) {
        pushMessage(
          "system",
          `Image exceeds ${MAX_IMAGE_DIMENSION}px on its longest side and could not be resized automatically; the model may reject it.`,
        );
      }
      stageClipboardImage(result.image);
    });
  }, [stageClipboardImage, pushMessage]);

  const handleRewindDecision = useCallback(
    (decision: RewindDecision) => {
      const p = pendingRewindRef.current;
      if (!p) return;
      setPendingRewind(null);
      p.resolve(decision === "yes");
    },
    [setPendingRewind],
  );

  // Persists the wizard result: key into ~/.star-cli/.env (exported into this
  // process so the model works without a restart), provider/model appended to
  // config.toml, and both pushed into the live config so /model sees them.
  const handleConnectSave = useCallback(
    async (answers: ConnectAnswers): Promise<string> => {
      const result = saveConnection(answers);
      config.providers.push(result.provider);
      config.models.push(result.model);
      return `Saved provider "${result.provider.name}" and model "${result.model.name}" to ${result.configPath}; the key is stored as ${result.provider.apiKeyEnv} in ${result.envPath}.`;
    },
    [config],
  );

  const handleConnectOpenConfig = useCallback((): string => {
    const file = globalConfigPath();
    openConfigFile(file);
    return `Opening ${file} with the system default app (open it manually if nothing showed up).`;
  }, []);

  const finishConnect = useCallback(
    (message: string) => {
      const p = pendingConnectRef.current;
      if (!p) return;
      setPendingConnect(null);
      p.resolve(message);
    },
    [setPendingConnect],
  );

  const cancelConnect = useCallback(() => {
    finishConnect("Connect cancelled — nothing was saved.");
  }, [finishConnect]);

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
      target.confirmHandler = (req) => {
        if (isAllowedByRules([...alwaysAllowedRef.current], req)) {
          return Promise.resolve(true);
        }
        const ask = async (): Promise<boolean> => {
          const preview = await generateDiffPreview(req.toolName, req.args, cwd).catch(() => null);
          return new Promise<boolean>((resolve) => {
            setPendingPermission({ request: req, preview, resolve });
          });
        };
        // Queue behind the currently open prompt: a concurrent request (e.g.
        // from a background subagent) that took the pending slot directly
        // would overwrite the previous resolve and leak its promise forever.
        const decision = permissionChainRef.current.then(ask);
        permissionChainRef.current = decision.then(
          () => undefined,
          () => undefined,
        );
        return decision;
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

  // Restore the todo panel only when this session explicitly continues the
  // project (started via -c/-r; /resume is handled in the resume callback).
  // A fresh session starts with an empty list even when the project's
  // .star/todos.json still holds a previous session's items.
  const resumedAtStart = initialMessages !== undefined;
  useEffect(() => {
    if (!resumedAtStart) return;
    loadTodos(cwd)
      .then(setTodos)
      .catch(() => {});
  }, [cwd, resumedAtStart]);

  // Mount-only listener registration: re-running this effect would detach and
  // cleanup() the managers, killing every in-flight background task, so it
  // must not depend on the config object identity (configRef reads instead).
  useEffect(() => {
    const onUpdate = (task: TaskSnapshot) => {
      setBgLabels(runningTaskLabels());
      pushMessage(
        "system",
        toTerminalSafe(
          task.status === "running" ? formatTaskStarted(task) : formatTaskFinished(task),
        ),
      );
      // Background tasks are exactly the case where the user has looked away.
      if (task.status !== "running") {
        notifyBell({
          enabled: configRef.current.notifyBell,
          thresholdSec: configRef.current.notifyBellThresholdSec,
          noNotifyEnv: process.env.STAR_NO_NOTIFY === "1",
        });
      }
    };
    const onAgentUpdate = (task: AgentTaskSnapshot) => {
      setBgLabels(runningTaskLabels());
      pushMessage("system", toTerminalSafe(formatAgentTaskUpdate(task)));
      if (task.status !== "running") {
        notifyBell({
          enabled: configRef.current.notifyBell,
          thresholdSec: configRef.current.notifyBellThresholdSec,
          noNotifyEnv: process.env.STAR_NO_NOTIFY === "1",
        });
      }
    };
    defaultTaskManager.on("update", onUpdate);
    defaultAgentTasks.on("update", onAgentUpdate);
    return () => {
      defaultTaskManager.off("update", onUpdate);
      defaultAgentTasks.off("update", onAgentUpdate);
      defaultTaskManager.cleanup();
      defaultAgentTasks.cleanup();
    };
  }, [pushMessage]);

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

  // Kills every still-running background shell task and subagent; returns the
  // count. The agent-task drain is discarded with it: stopped agents stay
  // un-notified otherwise, and the loop would inject their reports as user
  // messages at the next step boundary — into whatever session is active then.
  const stopBackgroundWork = useCallback((): number => {
    const killed = defaultTaskManager.cleanup();
    const killedAgents = defaultAgentTasks.cleanup();
    defaultAgentTasks.drainNotifications();
    return killed.length + killedAgents.length;
  }, []);

  const handleExit = useCallback(() => {
    const stopped = stopBackgroundWork();
    if (stopped > 0) {
      pushMessage("system", `${stopped} background task(s) still running; reports will be lost.`);
      // Let the warning commit to static output before the app tears down.
      setTimeout(exit, 50);
      return;
    }
    exit();
  }, [exit, pushMessage, stopBackgroundWork]);

  useInput((_input, key) => {
    if (key.escape) {
      // Popups with their own Esc handling (picker, rewind/plan confirms,
      // connect wizard) keep the key: interrupting here too would close the
      // popup and kill the running turn (or drop the queue) with one press.
      // The permission prompt has no Esc of its own, so it stays on the
      // interrupt path below.
      const popupOpen =
        planApprovalRef.current ||
        pendingRewindRef.current !== null ||
        pendingConnectRef.current !== null ||
        pickerRef.current !== null;
      if (popupOpen) {
        lastEscRef.current = null;
        return;
      }
      const busy = abortRef.current !== null || pendingRef.current !== null;
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
        pendingRewindRef.current ||
        pendingConnectRef.current ||
        pickerRef.current
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
        const modelConfig = resolveModelConfig(config, name);
        const loop = new AgentLoop({
          model: newModel,
          registry: createDefaultRegistry(),
          config,
          cwd,
          system: SYSTEM_PROMPT,
          sessionStore: sessionStoreRef.current,
          contextMaxTokens: contextWindowTokens(config, name),
          providerMetadata: reasoningEffortMetadata(config, name),
          temperature: modelConfig.temperature,
          streamIdleTimeoutSec: modelConfig.streamIdleTimeoutSec,
          streamFirstChunkTimeoutSec: modelConfig.streamFirstChunkTimeoutSec,
        });
        const prev = backendRef.current;
        if (prev instanceof AgentLoop) {
          await loop.loadMessages([...prev.getMessages()]);
        }
        attachConfirmHandler(loop);
        backendRef.current = loop;
        modelNameRef.current = name;
        setModelName(name);
        await sessionStoreRef.current?.setModel(name);
        return `Switched to model "${name}".`;
      } catch (error) {
        return `Failed to switch model: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    [config, cwd, attachConfirmHandler],
  );

  // Follow-up to the model picker: applies the chosen reasoning effort to the
  // live loop (no rebuild), then persists it to the model's [[models]] block.
  const pickReasoningEffort = useCallback(
    async (name: string): Promise<string> => {
      const modelConfig = config.models.find((m) => m.name === name);
      const current = modelConfig?.reasoningEffort;
      const levels =
        current && !REASONING_EFFORT_LEVELS.includes(current)
          ? [...REASONING_EFFORT_LEVELS, current]
          : REASONING_EFFORT_LEVELS;
      const options: SelectOption[] = [
        {
          value: "",
          label: "default",
          description: "send no effort field — the provider's server-side default applies",
          hint: current === undefined ? "current" : undefined,
        },
        ...levels.map((level) => ({
          value: level,
          label: level,
          description: "only works if the model/provider supports this level",
          hint: level === current ? "current" : undefined,
        })),
      ];
      const picked = await showPicker(`Reasoning effort for "${name}"`, options);
      if (picked === null || (picked === "" && current === undefined) || picked === current) {
        return `Reasoning effort unchanged${current ? ` — still "${current}"` : " — server default"}.`;
      }
      const effort = picked === "" ? undefined : picked;
      if (modelConfig) modelConfig.reasoningEffort = effort;
      const backend = backendRef.current;
      if (backend instanceof AgentLoop) {
        backend.setProviderMetadata(reasoningEffortMetadata(config, name));
      }
      const saved = await saveReasoningEffort(name, effort);
      const applied = effort === undefined ? "server default" : `"${effort}"`;
      const suffix = saved
        ? "Saved to config."
        : `This session only — "${name}" has no [[models]] block in the global config file; add reasoningEffort there to persist it.`;
      return `Reasoning effort for "${name}" set to ${applied}. ${suffix}`;
    },
    [config, showPicker],
  );

  const handleConnectSetDefault = useCallback(
    async (modelName: string): Promise<string> => {
      saveDefaultModel(modelName);
      config.defaultModel = modelName;
      const switched = await switchModel(modelName);
      return `Default model set to "${modelName}" (saved to config). ${switched}`;
    },
    [config, switchModel],
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
      const store = await SessionStore.open(resolvedId);
      if (!store) {
        return `Session not found: ${id}`;
      }
      // Background work belongs to the conversation being replaced: left
      // running, subagent reports would drain into the resumed session's
      // history and its file changes into its checkpoints.
      const stopped = stopBackgroundWork();
      await current.loadMessages(resumed.messages);
      // Rebind persistence to the resumed session before anything else can
      // write: without this, new messages/usage/snapshots keep landing in the
      // previous session's directory.
      current.setSessionStore(store);
      sessionStoreRef.current = store;
      // Resuming is the explicit "continue this project" gesture: bring the
      // persisted todo list back into the panel (and the model's todo_read).
      setTodos(await loadTodos(cwd));
      hydrateSnapshots(await loadSessionSnapshots(store.dir));
      const display = buildDisplayMessages(resumed.messages);
      nextIdRef.current = display.length;
      applyMessages(display);
      usageRef.current = resumed.meta.usage ? { ...resumed.meta.usage } : emptyUsage();
      setUsageVersion((v) => v + 1);
      const stoppedNote =
        stopped > 0 ? ` Stopped ${stopped} background task(s) from the previous session.` : "";
      return `Resumed session ${resolvedId} (${resumed.messages.length} messages).${stoppedNote}`;
    },
    [applyMessages, cwd, stopBackgroundWork],
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
      turnStartedAtRef.current = turnStartedAt;
      streamedRef.current = "";
      lastCommittedLenRef.current = 0;
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
        const uncommitted = streamedRef.current.slice(lastCommittedLenRef.current);
        if (uncommitted.length > 0) {
          pushAssistantChunk(uncommitted, tight);
        }
        streamedRef.current = "";
        lastCommittedLenRef.current = 0;
        flushedRef.current = { ...flushedRef.current, streamed: "" };
        setStreamingText("");
      };
      tickerStopRef.current = startTicker((tick) => {
        setSpinnerTick(tick);
        const uncommitted = streamedRef.current.slice(lastCommittedLenRef.current);
        const split = splitCommittableLines(uncommitted, 8);
        if (split) {
          pushAssistantChunk(split.committed, true);
          // +1 for the newline splitCommittableLines consumed but did not
          // include in either half.
          lastCommittedLenRef.current += split.committed.length + 1;
        }
        const next: FlushState = {
          streamed: streamedRef.current.slice(lastCommittedLenRef.current),
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
                  `${thinkingIcon} thought: ${truncateTail(reasoningRef.current, THOUGHT_SUMMARY_LENGTH)}`,
                );
              }
            }
            streamedRef.current += toTerminalSafe(event.text);
          } else if (event.type === "reasoning") {
            reasoningRef.current += toTerminalSafe(event.text);
          } else if (event.type === "tool-call") {
            // Flush the text spoken before this call into history first, so the
            // card lands in chronological order instead of after the whole turn.
            commitStreamed(true);
            const card: ToolCardData = {
              id: event.id,
              name: event.name,
              argsSummary: summarizeArgs(event.args),
            };
            // Capture the write/edit diff preview now: by the time the result
            // arrives the file already holds the new content and an overwrite
            // would diff empty. Awaiting pauses the event stream for a local
            // file read only; the preview is best-effort.
            if (event.name === "write_file" || event.name === "edit_file") {
              try {
                const preview = await generateDiffPreview(event.name, event.args, cwd);
                if (preview) card.diff = preview.lines;
              } catch {
                // Preview failure must not block the tool call.
              }
            }
            toolCardsRef.current.set(event.id, card);
            if (event.name === "todo_write") {
              const list = parseTodoArgs(event.args);
              if (list) setTodos(list);
            }
            setActivity(
              `${toolIcon(event.name)} running ${event.name}: ${summarizeArgs(event.args, 60)}`,
            );
          } else if (event.type === "tool-call-progress") {
            setActivity(
              `${toolIcon(event.name)} receiving ${event.name} arguments… ${formatByteCount(event.bytes)}`,
            );
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
              undefined,
              undefined,
              undefined,
              event.isError ? undefined : card.diff,
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
              if (event.usage.cachedPromptTokens) {
                usage.cachedPromptTokens =
                  (usage.cachedPromptTokens ?? 0) + event.usage.cachedPromptTokens;
              }
              if (event.usage.cacheReadInputTokens) {
                usage.cacheReadInputTokens =
                  (usage.cacheReadInputTokens ?? 0) + event.usage.cacheReadInputTokens;
              }
              if (cacheUsageReported(event.usage)) {
                if (!usage.cache) usage.cache = { cachedTokens: 0, promptTokens: 0 };
                addToCacheTotals(usage.cache, event.usage);
              }
              setUsageVersion((v) => v + 1);
              sessionStoreRef.current?.addUsage(event.usage).catch(() => {});
            }
          } else if (event.type === "retry") {
            // The resend re-streams the reply from scratch, so roll the
            // buffer back to the committed prefix: the failed attempt's
            // uncommitted tail must go before it duplicates on screen.
            // Already-committed chunks stay (static history can't be edited).
            streamedRef.current = streamedRef.current.slice(0, lastCommittedLenRef.current);
            flushedRef.current = { ...flushedRef.current, streamed: "" };
            setStreamingText("");
            const wait =
              event.delayMs !== undefined && event.delayMs >= 1000
                ? ` in ${Math.round(event.delayMs / 1000)}s`
                : "";
            pushMessage(
              "system",
              `Request failed, retrying (${event.attempt}/${event.maxAttempts})${wait}: ${event.reason}`,
            );
          } else if (event.type === "notice") {
            pushMessage("system", event.message);
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
        const finalText = streamedRef.current.slice(lastCommittedLenRef.current);
        streamedRef.current = "";
        lastCommittedLenRef.current = 0;
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
          pushAssistantChunk(finalText, false, interrupted);
        } else if (interrupted && turnChunksRef.current > 0) {
          // The partial reply was already committed to history in pieces, so
          // the marker lands as its own trailing chunk instead.
          pushAssistantChunk("", false, true);
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
            `${m.name === modelNameRef.current ? "*" : " "} ${m.name} (${m.provider}/${m.model})${m.reasoningEffort ? ` [effort: ${m.reasoningEffort}]` : ""}`,
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
      pickModel: async () => {
        const models = listModels(config);
        if (models.length === 0) return "No models configured.";
        const options: SelectOption[] = models.map((m) => {
          const parts = [
            `${m.provider}/${m.model}`,
            `${formatTokens(contextWindowTokens(config, m.name))} ctx`,
          ];
          if (m.reasoningEffort) parts.push(`effort: ${m.reasoningEffort}`);
          if (m.promptPrice !== undefined && m.completionPrice !== undefined) {
            parts.push(`$${m.promptPrice}/$${m.completionPrice} per 1M tokens`);
          }
          return {
            value: m.name,
            label: m.name,
            description: parts.join(" · "),
            hint: m.name === modelNameRef.current ? "current" : undefined,
          };
        });
        const picked = await showPicker("Select a model", options);
        if (!picked) return `Model unchanged — still "${modelNameRef.current}".`;
        const results: string[] = [];
        if (picked === modelNameRef.current) {
          results.push(`Model unchanged — still "${picked}".`);
        } else {
          const switched = await switchModel(picked);
          if (switched.startsWith("Failed to switch model:")) return switched;
          results.push(switched);
        }
        results.push(await pickReasoningEffort(picked));
        return results.join("\n");
      },
      pickPermissionMode: async () => {
        const current = config.permissionMode;
        const descriptions: Record<string, string> = {
          ask: "reads allowed; writes/exec ask for confirmation",
          auto: "everything allowed except hard-denied dangerous commands/paths",
          readonly: "read-only; all writes/exec denied",
          yolo: "allow everything, never ask (disables ALL safety checks)",
          plan: "read-only research, then approve a plan before executing (this session only)",
        };
        const options: SelectOption[] = ["ask", "auto", "readonly", "yolo", "plan"].map((m) => ({
          value: m,
          label: m,
          description: descriptions[m],
          hint: m === current ? "current" : undefined,
        }));
        const picked = await showPicker("Select a permission mode", options);
        if (!picked || picked === current) {
          return `Permission mode unchanged — still ${current}.`;
        }
        if (picked === "plan") return ctx.planMode();
        return ctx.permissionMode(picked);
      },
      pickSession: async (all) => {
        // Resuming the live session would open a second SessionStore on the
        // same directory and race its own meta writes — exclude it.
        const currentId = sessionStoreRef.current?.id;
        const entries = (await listSessionEntries(all ? undefined : cwd))
          .filter((entry) => entry.meta.id !== currentId)
          .slice(0, SESSION_PICKER_CAP);
        if (entries.length === 0) {
          return all ? "No sessions found." : "No sessions found for this directory.";
        }
        const options: SelectOption[] = await Promise.all(
          entries.map(async ({ meta, messageCount }) => {
            const parts = [`${messageCount} messages · ${relativeTime(meta.updatedAt)}`];
            const preview = await sessionPreview(meta.id);
            if (preview) {
              parts.push(
                preview.length > SESSION_PREVIEW_MAX
                  ? `${preview.slice(0, SESSION_PREVIEW_MAX)}…`
                  : preview,
              );
            }
            if (all) parts.push(`[${meta.cwd}]`);
            return {
              value: meta.id,
              label: meta.title || shortSessionId(meta.id),
              description: parts.join(" · "),
            };
          }),
        );
        const picked = await showPicker(
          all ? "Resume a session (all directories)" : "Resume a session",
          options,
        );
        if (!picked) return "Session unchanged — picker cancelled.";
        return resume(picked);
      },
      forkSession: async () => {
        const current = backendRef.current;
        const store = sessionStoreRef.current;
        if (!(current instanceof AgentLoop) || !store) {
          return "Nothing to fork — no active session.";
        }
        const messages = await store.messages();
        if (messages.length === 0) {
          return "Nothing to fork — the current session has no messages yet.";
        }
        const fork = await SessionStore.create(cwd, modelNameRef.current);
        await fork.replaceMessages(messages);
        const oldMeta = await store.meta();
        const title = `Fork of ${oldMeta.title || shortSessionId(oldMeta.id)}`;
        await fork.setTitle(title);
        current.setSessionStore(fork);
        sessionStoreRef.current = fork;
        return `Forked into new session ${fork.id} ("${title}") and switched to it. Checkpoints and rewind history do not carry over.`;
      },
      newSession: async () => {
        const current = backendRef.current;
        if (!(current instanceof AgentLoop)) {
          return "Current backend does not support starting a new session.";
        }
        // Background work belongs to the conversation being abandoned: left
        // running, subagent reports would drain into the new session's
        // history and its file changes into its checkpoints.
        const stopped = stopBackgroundWork();
        const store = await SessionStore.create(cwd, modelNameRef.current);
        current.setSessionStore(store);
        sessionStoreRef.current = store;
        // Keep the leading system prompt, drop everything else.
        const [first] = current.getMessages();
        await current.loadMessages(first?.role === "system" ? [first] : []);
        clearSnapshots();
        redrawMessages([]);
        // A new session no longer carries the project's persisted todo list.
        resetTodos();
        setTodos([]);
        usageRef.current = emptyUsage();
        budgetWarnedRef.current = false;
        budgetExceededRef.current = false;
        setUsageVersion((v) => v + 1);
        const stoppedNote =
          stopped > 0 ? ` Stopped ${stopped} background task(s) from the previous session.` : "";
        return `Started a new session (${store.id}) with a clean context.${stoppedNote}`;
      },
      connect: async () => {
        if (pendingConnectRef.current) return "The connect wizard is already open.";
        return new Promise<string>((resolve) => {
          setPendingConnect({ resolve });
        });
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
        // No nesting: a second /compact (or any concurrent prompt) would race
        // the loadMessages() at the end of this one.
        if (busyCommandRef.current) {
          return `Busy — /${busyCommandRef.current} is still running.`;
        }
        busyCommandRef.current = "compact";
        let summaryModel = null;
        try {
          summaryModel = createModel(config, modelNameRef.current);
        } catch {
          summaryModel = null;
        }
        // /compact is refused mid-turn, so the stream ticker is free to reuse:
        // drive the spinner with a busy label while compaction runs — the
        // summary call alone can take up to 60s on a slow relay.
        tickerStopRef.current = startTicker((tick) => setSpinnerTick(tick));
        setActivity("compacting context…");
        try {
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
        } finally {
          tickerStopRef.current?.();
          tickerStopRef.current = null;
          setActivity(null);
          busyCommandRef.current = null;
          // Prompts queued while compaction ran start now that the history
          // rewrite is done (same drain as the end of a stream turn).
          const nextPrompt = queueRef.current.dequeue();
          if (nextPrompt) {
            setQueueItems(queueRef.current.list());
            void runStreamRef.current?.(nextPrompt.text, nextPrompt.images);
          }
        }
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
        // Read-only preview first: how many messages the retraction drops and
        // which file reverts the turn implies — the whole-tree file list when
        // a git snapshot tracked the turn, per-file diffs otherwise. Nothing
        // is touched until the user confirms.
        const preview = current.previewLastTurnRetraction();
        if (preview.removed === 0) {
          return "Nothing to undo (no conversation turn to retract).";
        }
        const diffs = preview.tree
          ? await buildUndoTreeDiffs(cwd, preview.tree)
          : await buildUndoDiffs(
              preview.turn !== undefined ? listTurnSnapshots(preview.turn) : [],
              cwd,
            );
        const summary = preview.tree
          ? `${preview.removed} message(s) will be retracted, and the working tree restored to the turn's start (git snapshot — covers changes from any tool, bash included).`
          : `${preview.removed} message(s) will be retracted, ${diffs.length} file change(s) reverted.`;
        // Undo is destructive: confirm before touching files or history.
        const confirmed = await new Promise<boolean>((resolve) => {
          setPendingRewind({
            title: "Undo last turn",
            confirmLabel: "undo",
            summary,
            diffs,
            resolve,
          });
        });
        if (!confirmed) {
          return "Undo cancelled.";
        }
        // Turn-scoped undo: retract the last turn's messages, and revert file
        // changes only when they provably belong to that same turn — a git
        // tree restore when the turn was tracked (feeding the redo stack),
        // per-file snapshots otherwise.
        const outcome = await current.undoLastTurn();
        if (outcome.removed === 0) {
          return "Nothing to undo (no conversation turn to retract).";
        }
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
        return [
          ...outcome.reverted,
          `Retracted the last conversation turn (${outcome.removed} messages).`,
        ].join("\n");
      },
      redo: async () => {
        const current = backendRef.current;
        if (!(current instanceof AgentLoop)) {
          return "Nothing to redo.";
        }
        const entry = current.peekRedo();
        if (!entry) {
          return "Nothing to redo.";
        }
        // Redo rewrites the working tree: confirm first, like /undo.
        const confirmed = await new Promise<boolean>((resolve) => {
          setPendingRewind({
            title: "Redo last undo",
            confirmLabel: "redo",
            summary: formatRedoSummary(entry),
            resolve,
          });
        });
        if (!confirmed) {
          return "Redo cancelled.";
        }
        const result = await current.redoLastUndo();
        if (!result) {
          return "Nothing to redo.";
        }
        return formatRedoResult(result);
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
        // /commit lands here: respect the turn/command guards instead of
        // clobbering the live stream's abort controller — queue like a
        // typeahead prompt.
        if (abortRef.current || busyCommandRef.current) {
          queueRef.current.enqueue({ text, images: [] });
          setQueueItems(queueRef.current.list());
          return;
        }
        await runStream(text);
      },
      describeConfig: () =>
        [
          `defaultModel: ${config.defaultModel || "(none)"}`,
          `permissionMode: ${config.permissionMode}`,
          `providers (${config.providers.length}): ${config.providers.map((p) => p.name).join(", ") || "(none)"}`,
          `models (${config.models.length}): ${config.models.map((m) => m.name).join(", ") || "(none)"}`,
          `maxSteps: ${config.maxSteps === 0 ? "unlimited" : config.maxSteps}`,
          `contextMaxTokens: ${config.contextMaxTokens}`,
          `compactThresholdTokens: ${config.compactThresholdTokens ?? "(context window)"}`,
          `streamIdleTimeoutSec: ${config.streamIdleTimeoutSec}`,
          `streamFirstChunkTimeoutSec: ${config.streamFirstChunkTimeoutSec}`,
          `streamMaxRetries: ${config.streamMaxRetries}`,
          `maxAutoContinues: ${config.maxAutoContinues}`,
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
    pickReasoningEffort,
    resume,
    runStream,
    applyMessages,
    redrawMessages,
    applySessionMode,
    setPendingRewind,
    setPendingConnect,
    showPicker,
    stopBackgroundWork,
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
      appendHistory(text);
      if (text.startsWith("!")) {
        // A bang would clobber the streaming turn's abort controller, so it
        // waits in the queue like a regular prompt.
        if (abortRef.current || busyCommandRef.current) {
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
          const suggestions = registry.complete(parsed.name).map((cmd) => cmd.name);
          pushMessage(
            "system",
            `Unknown command: /${parsed.name} (try /help)${didYouMeanSuffix(suggestions)}`,
          );
          return;
        }
        if (BUSY_BLOCKED_COMMANDS.has(parsed.name)) {
          if (abortRef.current) {
            pushMessage(
              "system",
              "Busy — wait for the turn to finish or press Esc to interrupt it.",
            );
            return;
          }
          if (busyCommandRef.current) {
            pushMessage("system", `Busy — /${busyCommandRef.current} is still running.`);
            return;
          }
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
      if (abortRef.current || busyCommandRef.current) {
        queueRef.current.enqueue({ text, images });
        setQueueItems(queueRef.current.list());
        return;
      }
      void runStream(text, images);
    },
    [registry, pushMessage, runStream, runShellBang, config, clearPendingImages, sessionCostUsd],
  );

  const commandHints = useMemo(
    () =>
      registry.list().map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage ?? `/${cmd.name}`,
      })),
    [registry],
  );

  // Expensive status-bar bits (git branch, token estimate over the full
  // history) refresh on turn boundaries, history rewrites and model switches,
  // not per tick. The git probe goes through the 15s TTL cache: the uncached
  // summary runs several synchronous git processes that would block the
  // event loop on every refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isStreaming, epoch and modelName are deliberate refresh triggers, not values read inside
  useEffect(() => {
    setGitBranch(getGitSummaryCached(cwd)?.branch ?? null);
    const current = backendRef.current;
    if (current instanceof AgentLoop) {
      const window_ = contextWindowTokens(config, modelNameRef.current);
      const pct = (estimateTokens([...current.getMessages()]) / window_) * 100;
      // One decimal below 10% so small-but-real usage doesn't display as 0%.
      setContextPercent(pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct));
    } else {
      setContextPercent(null);
    }
  }, [cwd, config, isStreaming, epoch, modelName]);

  const sessionCost = sessionCostUsd();

  return (
    <Box flexDirection="column">
      <MessageList key={`messages-${epoch}`} messages={messages} />
      {(thinking || activity !== null) && (
        <ThinkingIndicator
          reasoning={thinkingText}
          frame={spinnerTick}
          activity={activity ?? undefined}
          elapsedSec={Math.max(0, Math.floor((Date.now() - turnStartedAtRef.current) / 1000))}
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
        <RewindConfirmPrompt
          summary={pendingRewind.summary}
          title={pendingRewind.title}
          confirmLabel={pendingRewind.confirmLabel}
          diffs={pendingRewind.diffs}
          onDecision={handleRewindDecision}
        />
      )}
      {picker && (
        <SelectPrompt
          title={picker.title}
          options={picker.options}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      )}
      {pendingConnect && (
        <ConnectWizard
          existingProviderNames={config.providers.map((p) => p.name)}
          existingModelNames={config.models.map((m) => m.name)}
          onSave={handleConnectSave}
          onSetDefault={handleConnectSetDefault}
          onOpenConfig={handleConnectOpenConfig}
          onFinish={finishConnect}
          onCancel={cancelConnect}
        />
      )}
      {queueItems.slice(0, MAX_VISIBLE_QUEUED).map((item) => (
        <Text key={item.id} dimColor>
          queued: {item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text}
        </Text>
      ))}
      {queueItems.length > MAX_VISIBLE_QUEUED && (
        <Text dimColor>… {queueItems.length - MAX_VISIBLE_QUEUED} more queued</Text>
      )}
      {pendingImages.map((staged) => (
        <Text key={staged.id} dimColor>
          [image attached: {staged.image.path}]
        </Text>
      ))}
      <TodoPanel todos={todos} />
      <InputBox
        isStreaming={isStreaming}
        disabled={
          pending !== null ||
          planApproval ||
          pendingRewind !== null ||
          pendingConnect !== null ||
          picker !== null
        }
        commands={commandHints}
        cwd={cwd}
        refill={inputRefill}
        initialHistory={initialHistory}
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
        cachePercent={usageRef.current.cache ? cacheHitPercent(usageRef.current.cache) : null}
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

// Ink's default exitOnCtrlC would unmount the app on \x03, bypassing the
// InputBox Ctrl+C semantics (interrupt the turn / clear the draft) and the
// session's final persistence. The app owns Ctrl+C; Ctrl+D and /exit handle
// quitting. Exported so tests can pin the production value — the Ink test
// harness mirrors it.
export const REPL_RENDER_OPTIONS = { exitOnCtrlC: false };

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
    REPL_RENDER_OPTIONS,
  );
}
