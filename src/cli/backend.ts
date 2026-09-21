import type { StreamEvent } from "../core/events";
import type { PermissionRequest } from "../permissions/types";

export interface StreamOptions {
  /** Text persisted to the session store instead of `input` (e.g. the raw prompt before @mention injection). */
  persistAs?: string;
}

export interface ChatBackend {
  stream(input: string, signal: AbortSignal, opts?: StreamOptions): AsyncGenerator<StreamEvent>;
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;
  onHookWarning?: (message: string) => void;
}

export class EchoBackend implements ChatBackend {
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;

  constructor(private readonly delayMs = 20) {}

  async *stream(input: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const chunks = input.split(/(\s+)/).filter((s) => s.length > 0);
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
