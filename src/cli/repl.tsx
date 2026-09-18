import { Box, render, useApp, useInput } from "ink";
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
import { TodoStore, createDefaultRegistry } from "../tools";
import { undoLastSnapshot } from "../tools/fs/snapshots";
import { formatTodos } from "../tools/todo";
import type { ChatBackend } from "./backend";
import { compactSession, exportSession } from "./commands/actions";
import { registerBuiltinCommands } from "./commands/builtin";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { type PermissionDecision, PermissionPrompt } from "./components/PermissionPrompt";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";
import { ToolCallCard, type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { buildDisplayMessages, summarizeArgs } from "./format";
import { resolveMentions } from "./mentions";

const FLUSH_INTERVAL_MS = 30;

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
  const [usageVersion, setUsageVersion] = useState(0);
  const [modelName, setModelName] = useState(model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [cardsVersion, setCardsVersion] = useState(0);

  const backendRef = useRef<ChatBackend>(backend);
  const nextIdRef = useRef(initialDisplay.length);
  const abortRef = useRef<AbortController | null>(null);
  const streamedRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
      target.confirmHandler = (req) => {
        if (isAllowedByRules([...alwaysAllowedRef.current], req)) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          setPendingPermission({ request: req, resolve });
        });
      };
    },
    [setPendingPermission],
  );

  useEffect(() => {
    attachConfirmHandler(backendRef.current);
    return () => {
      if (flushTimerRef.current !== null) clearInterval(flushTimerRef.current);
      abortRef.current?.abort();
      pendingRef.current?.resolve(false);
    };
  }, [attachConfirmHandler]);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    const p = pendingRef.current;
    if (p) {
      setPendingPermission(null);
      p.resolve(false);
    }
  }, [setPendingPermission]);

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

  const registry = useMemo(() => {
    const ctx: CommandContext = {
      addSystemMessage: (text) => pushMessage("system", text),
      clearMessages: () => {
        setMessages([]);
        setEpoch((e) => e + 1);
      },
      exit: () => exit(),
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
      showUsage: () => formatUsage(usageRef.current),
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
    return Object.assign(reg, { ctx });
  }, [pushMessage, exit, config, cwd, switchModel, resume, sessionStore]);

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
      setStreamingText("");
      setIsStreaming(true);
      flushTimerRef.current = setInterval(() => {
        setStreamingText(streamedRef.current);
      }, FLUSH_INTERVAL_MS);
      try {
        for await (const event of backendRef.current.stream(resolved.input, controller.signal, {
          persistAs: input,
        })) {
          if (event.type === "text-delta") {
            streamedRef.current += event.text;
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
              card.result = event.content;
              card.isError = event.isError ?? false;
              setCardsVersion((v) => v + 1);
            }
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
            pushMessage("system", `Error: ${event.error.message}`);
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          pushMessage("system", `Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (flushTimerRef.current !== null) {
          clearInterval(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        abortRef.current = null;
        setIsStreaming(false);
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

  const handleSubmit = useCallback(
    (text: string) => {
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
    [registry, pushMessage, runStream],
  );

  const cards = [...toolCardsRef.current.values()];

  return (
    <Box flexDirection="column">
      <MessageList key={epoch} messages={messages} />
      {cards.length > 0 && (
        <Box key={cardsVersion} flexDirection="column">
          {cards.map((card) => (
            <ToolCallCard key={card.id} card={card} />
          ))}
        </Box>
      )}
      {streamingText !== null && <StreamingMessage text={streamingText} />}
      {pending && <PermissionPrompt request={pending.request} onDecision={handleDecision} />}
      <InputBox
        isStreaming={isStreaming}
        disabled={pending !== null}
        onSubmit={handleSubmit}
        onInterrupt={interrupt}
        onExit={exit}
      />
      <StatusBar
        key={usageVersion}
        model={modelName}
        permissionMode={permissionMode}
        tokens={usageRef.current.totalTokens}
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
