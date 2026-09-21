import type { StreamEvent } from "../core/events";
import type { ChatInput } from "../core/messages";
import type { PermissionRequest } from "../permissions/types";

export interface StreamOptions {
  /** Text persisted to the session store instead of `input` (e.g. the raw prompt before @mention injection). */
  persistAs?: string;
}

export interface ChatBackend {
  stream(input: ChatInput, signal: AbortSignal, opts?: StreamOptions): AsyncGenerator<StreamEvent>;
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;
  onHookWarning?: (message: string) => void;
  // Drops the last user turn from history + persistence (double-Esc editing).
  retractLastTurn?(): Promise<{ removed: number; turn?: number }>;
}

export class EchoBackend implements ChatBackend {
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;

  constructor(private readonly delayMs = 20) {}

  async *stream(input: ChatInput, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const text = typeof input === "string" ? input : input.text;
    const chunks = text.split(/(\s+)/).filter((s) => s.length > 0);
    for (const chunk of chunks) {
      if (signal.aborted) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, this.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      yield { type: "text-delta", text: chunk };
    }
    yield { type: "finish", finishReason: "stop" };
  }
}
