import { Box, Text, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLoop } from "../agent/loop";
import { addAllowRule } from "../config/save";
import type { StarConfig } from "../config/schema";
import type { CoreMessage } from "../core/messages";
import { createModel } from "../llm/provider";
import { listModels } from "../llm/registry";
import { buildAllowRule, isAllowedByRules } from "../permissions/allow";
import type { PermissionRequest } from "../permissions/types";
import { formatSessionList, resumeSession } from "../session/resume";
import { SessionStore } from "../session/store";
import { formatTaskFinished, formatTaskList } from "../tasks/format";
import { type TaskSnapshot, defaultTaskManager } from "../tasks/manager";
import { TodoStore, createDefaultRegistry } from "../tools";
import { undoLastSnapshot } from "../tools/fs/snapshots";
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
import { ToolCallCard, type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { estimateCost } from "./cost";
import { type DiffPreview, generateDiffPreview } from "./diff-preview";
import { buildDisplayMessages, formatStreamError, summarizeArgs } from "./format";
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
  // usageVersion / cardsVersion bump counters: values are never read; setting them
  // re-renders so usageRef / toolCardsRef contents flow into StatusBar and the cards.
  const [, setUsageVersion] = useState(0);
  const [modelName, setModelName] = useState(model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [, setCardsVersion] = useState(0);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [bgCount, setBgCount] = useState(() => defaultTaskManager.runningCount());

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

  const pushMessage = useCallback((role: DisplayMessage["role"], text: string, note?: string) => {
    setMessages((prev) => [...prev, { id: nextIdRef.current++, role, text, note }]);
  }, []);

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
      setBgCount(defaultTaskManager.runningCount());
      if (task.status !== "running") {
        pushMessage("system", formatTaskFinished(task));
      }
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
      setThinking(true);
      setThinkingText("");
      setThoughtSummary(null);
      setStreamingText("");
      setIsStreaming(true);
      flushedRef.current = { streamed: "", reasoning: "" };
      tickerStopRef.current = startTicker((tick) => {
        setSpinnerTick(tick);
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
            toolCardsRef.current.set(event.id, {
              id: event.id,
              name: event.name,
              argsSummary: summarizeArgs(event.args),
            });
            setCardsVersion((v) => v + 1);
          } else if (event.type === "tool-result") {
            const card = toolCardsRef.current.get(event.id);
            if (card) {
              toolCardsRef.current.set(event.id, {
                ...card,
                result: event.content,
                isError: event.isError ?? false,
              });
              setCardsVersion((v) => v + 1);
            }
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
        if (!(error instanceof DOMException && error.name === "AbortError")) {
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
        const finalText = streamedRef.current;
        streamedRef.current = "";
        setStreamingText(null);
        if (finalText.length > 0) {
          pushMessage(
            "assistant",
            controller.signal.aborted ? `${finalText} [interrupted]` : finalText,
          );
        }
        for (const card of toolCardsRef.current.values()) {
          pushMessage("tool", formatToolCard(card));
        }
        toolCardsRef.current.clear();
        setCardsVersion((v) => v + 1);
        const p = pendingRef.current;
        if (p) {
          setPendingPermission(null);
          p.resolve(false);
        }
      }
    },
    [pushMessage, setPendingPermission, sessionStore, cwd],
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
      undo: () => undoLastSnapshot(),
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

  const cards = [...toolCardsRef.current.values()];

  return (
    <Box flexDirection="column">
      <MessageList key={`messages-${epoch}`} messages={messages} />
      {cards.length > 0 && (
        <Box flexDirection="column">
          {cards.map((card) => (
            <ToolCallCard key={card.id} card={card} />
          ))}
        </Box>
      )}
      {thinking && <ThinkingIndicator reasoning={thinkingText} frame={spinnerTick} />}
      {!thinking && thoughtSummary !== null && <Text dimColor>{thoughtSummary}</Text>}
      {streamingText !== null && <StreamingMessage text={streamingText} />}
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
        permissionMode={permissionMode}
        tokens={usageRef.current.totalTokens}
        backgroundTasks={bgCount}
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
