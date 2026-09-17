import { Box, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLoop } from "../agent/loop";
import type { StarConfig } from "../config/schema";
import type { CoreMessage } from "../core/messages";
import { createModel } from "../llm/provider";
import { listModels } from "../llm/registry";
import type { PermissionRequest } from "../permissions/types";
import { formatSessionList, resumeSession } from "../session/resume";
import { SessionStore } from "../session/store";
import { TodoStore, createDefaultRegistry } from "../tools";
import { formatTodos } from "../tools/todo";
import type { ChatBackend } from "./backend";
import { registerBuiltinCommands } from "./commands/builtin";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { type PermissionDecision, PermissionPrompt } from "./components/PermissionPrompt";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";
import { ToolCallCard, type ToolCardData, formatToolCard } from "./components/ToolCallCard";
import { summarizeArgs } from "./format";

const FLUSH_INTERVAL_MS = 30;

interface PendingPermission {
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
}

function coreMessageText(message: CoreMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join(" ");
  }
  return "";
}

interface ReplProps {
  backend: ChatBackend;
  model: string;
  permissionMode: string;
  config: StarConfig;
  cwd: string;
  sessionStore: SessionStore | null;
}

export function Repl({ backend, model, permissionMode, config, cwd, sessionStore }: ReplProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [modelName, setModelName] = useState(model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [cardsVersion, setCardsVersion] = useState(0);

  const backendRef = useRef<ChatBackend>(backend);
  const nextIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const streamedRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toolCardsRef = useRef(new Map<string, ToolCardData>());
  const pendingRef = useRef<PendingPermission | null>(null);
  const alwaysAllowedRef = useRef(new Set<string>());
  const modelNameRef = useRef(model);

  const pushMessage = useCallback((role: DisplayMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { id: nextIdRef.current++, role, text }]);
  }, []);

  const setPendingPermission = useCallback((p: PendingPermission | null) => {
    pendingRef.current = p;
    setPending(p);
  }, []);

  const attachConfirmHandler = useCallback(
    (target: ChatBackend) => {
      target.confirmHandler = (req) => {
        if (alwaysAllowedRef.current.has(req.toolName)) {
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
        alwaysAllowedRef.current.add(p.request.toolName);
      }
      setPendingPermission(null);
      p.resolve(decision !== "no");
    },
    [setPendingPermission],
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
    const display: DisplayMessage[] = [];
    let collapsed = 0;
    for (const message of resumed.messages) {
      if (message.role === "user" || message.role === "assistant") {
        const text = coreMessageText(message);
        if (text) {
          display.push({ id: nextIdRef.current++, role: message.role, text });
        } else {
          collapsed++;
        }
      } else if (message.role === "tool") {
        collapsed++;
      }
    }
    if (collapsed > 0) {
      display.push({
        id: nextIdRef.current++,
        role: "system",
        text: `已恢复 ${collapsed} 条历史消息`,
      });
    }
    setMessages(display);
    return `Resumed session ${id} (${resumed.messages.length} messages).`;
  }, []);

  const registry = useMemo(() => {
    const ctx: CommandContext = {
      addSystemMessage: (text) => pushMessage("system", text),
      clearMessages: () => setMessages([]),
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
        const metas = await SessionStore.list();
        return metas.length === 0 ? "No sessions found." : formatSessionList(metas);
      },
      resumeSession: resume,
      showTodos: async () => {
        const store = new TodoStore();
        await store.load(cwd);
        return formatTodos(store.list());
      },
      describeConfig: () =>
        [
          `defaultModel: ${config.defaultModel || "(none)"}`,
          `permissionMode: ${config.permissionMode}`,
          `providers (${config.providers.length}): ${config.providers.map((p) => p.name).join(", ") || "(none)"}`,
          `models (${config.models.length}): ${config.models.map((m) => m.name).join(", ") || "(none)"}`,
          `maxSteps: ${config.maxSteps}`,
          `contextMaxTokens: ${config.contextMaxTokens}`,
        ].join("\n"),
    };
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    return Object.assign(reg, { ctx });
  }, [pushMessage, exit, config, cwd, switchModel, resume]);

  const runStream = useCallback(
    async (input: string) => {
      pushMessage("user", input);
      const controller = new AbortController();
      abortRef.current = controller;
      streamedRef.current = "";
      setStreamingText("");
      setIsStreaming(true);
      flushTimerRef.current = setInterval(() => {
        setStreamingText(streamedRef.current);
      }, FLUSH_INTERVAL_MS);
      try {
        for await (const event of backendRef.current.stream(input, controller.signal)) {
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
              setTotalTokens((prev) => prev + (event.usage?.totalTokens ?? 0));
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
    [pushMessage, setPendingPermission],
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
      <MessageList messages={messages} />
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
      <StatusBar model={modelName} permissionMode={permissionMode} tokens={totalTokens} />
    </Box>
  );
}

export interface ReplOptions {
  model: string;
  permissionMode: string;
  config: StarConfig;
  cwd: string;
  sessionStore: SessionStore | null;
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
    />,
  );
}
