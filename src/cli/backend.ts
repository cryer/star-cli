import type { StreamEvent } from "../core/events";
import type { CoreMessage } from "../core/messages";

export interface ChatBackend {
  stream(input: string, history: CoreMessage[], signal: AbortSignal): AsyncGenerator<StreamEvent>;
}

export class EchoBackend implements ChatBackend {
  constructor(private readonly delayMs = 20) {}

  async *stream(
    input: string,
    _history: CoreMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
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
