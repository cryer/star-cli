import { Box, render, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TokenUsage } from "../core/events";
import type { CoreMessage } from "../core/messages";
import type { ChatBackend } from "./backend";
import { registerBuiltinCommands } from "./commands/builtin";
import { type CommandContext, CommandRegistry, parseSlashCommand } from "./commands/registry";
import { InputBox } from "./components/InputBox";
import { type DisplayMessage, MessageList } from "./components/MessageList";
import { StatusBar } from "./components/StatusBar";
import { StreamingMessage } from "./components/StreamingMessage";

const FLUSH_INTERVAL_MS = 30;

interface ReplProps {
  backend: ChatBackend;
  model: string;
  permissionMode: string;
}

export function Repl({ backend, model, permissionMode }: ReplProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage | undefined>(undefined);
  const nextIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushMessage = useCallback((role: DisplayMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { id: nextIdRef.current++, role, text }]);
  }, []);

  const registry = useMemo(() => {
    const ctx: CommandContext = {
      addSystemMessage: (text) => pushMessage("system", text),
      clearMessages: () => setMessages([]),
      exit: () => exit(),
    };
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    return Object.assign(reg, { ctx });
  }, [pushMessage, exit]);

  const flush = useCallback(() => {
    if (bufferRef.current.length > 0) {
      const chunk = bufferRef.current;
      bufferRef.current = "";
      setStreamingText((prev) => (prev ?? "") + chunk);
    }
  }, []);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      stopFlushTimer();
      abortRef.current?.abort();
    };
  }, [stopFlushTimer]);

  useInput((_input, key) => {
    if (key.escape && abortRef.current !== null) {
      interrupt();
    }
  });

  const runStream = useCallback(
    async (input: string) => {
      const history: CoreMessage[] = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
      pushMessage("user", input);
      const controller = new AbortController();
      abortRef.current = controller;
      bufferRef.current = "";
      setStreamingText("");
      flushTimerRef.current = setInterval(flush, FLUSH_INTERVAL_MS);
      try {
        for await (const event of backend.stream(input, history, controller.signal)) {
          if (event.type === "text-delta") {
            bufferRef.current += event.text;
          } else if (event.type === "finish") {
            if (event.usage) setUsage(event.usage);
          } else if (event.type === "error") {
            pushMessage("system", `Error: ${event.error.message}`);
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          pushMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        stopFlushTimer();
        flush();
        abortRef.current = null;
        setStreamingText((prev) => {
          const finalText = (prev ?? "") + bufferRef.current;
          bufferRef.current = "";
          if (finalText.length > 0) {
            const interrupted = controller.signal.aborted;
            pushMessage("assistant", interrupted ? `${finalText} [interrupted]` : finalText);
          }
          return null;
        });
      }
    },
    [backend, messages, pushMessage, flush, stopFlushTimer],
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

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      {streamingText !== null && <StreamingMessage text={streamingText} />}
      <InputBox
        isStreaming={abortRef.current !== null}
        onSubmit={handleSubmit}
        onInterrupt={interrupt}
        onExit={exit}
      />
      <StatusBar model={model} permissionMode={permissionMode} usage={usage} />
    </Box>
  );
}

export interface ReplOptions {
  model: string;
  permissionMode: string;
}

export function renderRepl(backend: ChatBackend, opts: ReplOptions) {
  return render(<Repl backend={backend} model={opts.model} permissionMode={opts.permissionMode} />);
}
