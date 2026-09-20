import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLoop } from "../agent/loop";
import { addAllowRule, savePermissionMode } from "../config/save";
import type { StarConfig } from "../config/schema";
import type { CoreMessage } from "../core/messages";
import { createModel } from "../llm/provider";
import { listModels } from "../llm/registry";
import { buildAllowRule, isAllowedByRules } from "../permissions/allow";
import type { PermissionRequest } from "../permissions/types";
import { formatSessionList, resumeSession } from "../session/resume";
import { SessionStore } from "../session/store";
import { formatTaskFinished, formatTaskList, formatTaskStarted } from "../tasks/format";
import { type TaskSnapshot, defaultTaskManager } from "../tasks/manager";
import { TodoStore, createDefaultRegistry } from "../tools";
import { undoTurnSnapshots } from "../tools/fs/snapshots";
import { formatTodos } from "../tools/todo";
import { VERSION } from "../version";
import type { ChatBackend } from "./backend";
import { compactSession, exportSession } from "./commands/actions";
import { registerBuiltinCommands } from "./commands/builtin";
import { registerCustomCommands } from "./commands/custom";
import { formatDoctorReport, runDoctor } from "./commands/doctor";
import { initProject } from "./commands/init-project";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { type PermissionDecision, PermissionPrompt } from "./components/PermissionPrompt";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";
import {
  THOUGHT_SUMMARY_LENGTH,
  ThinkingIndicator,
  truncateTail,
} from "./components/ThinkingIndicator";
import { type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { estimateCost } from "./cost";
import { type DiffPreview, generateDiffPreview } from "./diff-preview";
import {
  buildDisplayMessages,
  formatStreamError,
  splitCommittableLines,
  summarizeArgs,
} from "./format";
import { resolveMentions } from "./mentions";
import { executeShellBang } from "./shell-bang";
import { type FlushState, nextFlush, startTicker } from "./ticker";
import { checkForUpdate } from "./update-check";

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

function formatUsage(usage: UsageStats): string {
  return `API usage this session: ${usage.requests} requests, ${usage.promptTokens} prompt + ${usage.completionTokens} completion = ${usage.totalTokens} tokens`;
}

interface PendingPermission {
  request: PermissionRequest;
  preview: DiffPreview | null;
  resolve: (approved: boolean) => void;
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
  const modelNameRef = useRef(model);
  const usageRef = useRef<UsageStats>(initialUsage ? { ...initialUsage } : emptyUsage());
  // Number of assistant chunks already committed to static history this turn;
  // 0 means the next streamed text still needs the "star" header.
  const turnChunksRef = useRef(0);

  const pushMessage = useCallback(
    (role: DisplayMessage["role"], text: string, note?: string, tight?: boolean) => {
      setMessages((prev) => [...prev, { id: nextIdRef.current++, role, text, note, tight }]);
    },
    [],
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
    },
    [setPendingPermission, cwd],
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
    };
    defaultTaskManager.on("update", onUpdate);
    return () => {
      defaultTaskManager.off("update", onUpdate);
      defaultTaskManager.cleanup();
    };
  }, [pushMessage]);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    const p = pendingRef.current;
    if (p) {
      setPendingPermission(null);
      p.resolve(false);
    }
  }, [setPendingPermission]);

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
    if (key.escape) interrupt();
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
          sessionStore,
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
    [config, cwd, sessionStore, attachConfirmHandler],
  );

  const resume = useCallback(async (id: string): Promise<string> => {
    const current = backendRef.current;
    if (!(current instanceof AgentLoop)) {
      return "Current backend does not support resuming sessions.";
    }
    const resumed = await resumeSession(id);
    if (!resumed) {
      return `Session not found: ${id}`;
    }
    await current.loadMessages(resumed.messages);
    const display = buildDisplayMessages(resumed.messages);
    nextIdRef.current = display.length;
    setMessages(display);
    setEpoch((e) => e + 1);
    usageRef.current = resumed.meta.usage ? { ...resumed.meta.usage } : emptyUsage();
    setUsageVersion((v) => v + 1);
    return `Resumed session ${id} (${resumed.messages.length} messages).`;
  }, []);

  const runStream = useCallback(
    async (input: string) => {
      const resolved = await resolveMentions(input, cwd);
      pushMessage(
        "user",
        input,
        resolved.attached.length > 0 ? `attached: ${resolved.attached.join(", ")}` : undefined,
      );
      for (const skip of resolved.skipped) {
        pushMessage("system", `Skipped @${skip.path}: ${skip.reason}`);
      }
      const controller = new AbortController();
      abortRef.current = controller;
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
        for await (const event of backendRef.current.stream(resolved.input, controller.signal, {
          persistAs: input,
        })) {
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
              sessionStore?.addUsage(event.usage).catch(() => {});
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
      }
    },
    [pushMessage, pushAssistantChunk, setPendingPermission, sessionStore, cwd],
  );

  const registry = useMemo(() => {
    const ctx: CommandContext = {
      addSystemMessage: (text) => pushMessage("system", text),
      clearMessages: () => {
        setMessages([]);
        setEpoch((e) => e + 1);
      },
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
      listSessions: async () => {
        const metas = await SessionStore.list(cwd);
        return metas.length === 0
          ? "No sessions found for this directory."
          : formatSessionList(metas);
      },
      resumeSession: resume,
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
      compactContext: async () => {
        let summaryModel = null;
        try {
          summaryModel = createModel(config, modelNameRef.current);
        } catch {
          summaryModel = null;
        }
        const result = await compactSession({
          backend: backendRef.current,
          sessionStore,
          config,
          model: summaryModel,
        });
        if (result.compacted && result.messages) {
          const display = buildDisplayMessages(result.messages);
          nextIdRef.current = display.length;
          setMessages(display);
          setEpoch((e) => e + 1);
        }
        return result.message;
      },
      exportSession: (arg) =>
        exportSession({ backend: backendRef.current, sessionStore, cwd, arg }),
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
        // the turn produced (answer chunks, tool cards, notifications).
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i]?.role === "user") return prev.slice(0, i);
          }
          return prev;
        });
        setEpoch((e) => e + 1);
        return [...reverted, `Retracted the last conversation turn (${removed} messages).`].join(
          "\n",
        );
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
        setPermissionModeState(mode);
        await savePermissionMode(mode);
        return mode === "yolo"
          ? "Permission mode set to yolo — ALL safety checks disabled, tools run without asking. Saved to config."
          : `Permission mode set to ${mode}. Saved to config.`;
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
          `permissions.allow (${config.permissions.allow.length}): ${config.permissions.allow.join(", ") || "(none)"}`,
        ].join("\n"),
    };
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    registerCustomCommands(reg, cwd);
    return Object.assign(reg, { ctx });
  }, [pushMessage, handleExit, config, cwd, switchModel, resume, sessionStore, runStream]);

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
      void runStream(text);
    },
    [registry, pushMessage, runStream, runShellBang],
  );

  const commandHints = useMemo(
    () => registry.list().map((cmd) => ({ name: cmd.name, description: cmd.description })),
    [registry],
  );

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
      <InputBox
        isStreaming={isStreaming}
        disabled={pending !== null}
        commands={commandHints}
        onSubmit={handleSubmit}
        onInterrupt={interrupt}
        onExit={handleExit}
      />
      <StatusBar
        model={modelName}
        permissionMode={permissionModeState}
        tokens={usageRef.current.totalTokens}
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
