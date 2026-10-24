import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { printMode } from "../src/cli/print-mode";
import { ConfigSchema } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

function config() {
  return ConfigSchema.parse({
    defaultModel: "test",
    models: [],
    providers: [],
    streamMaxRetries: 1,
    gitSnapshots: false,
  });
}

describe("production printMode", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-print-mode-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("drops failed-attempt output instead of duplicating it after a retry", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call += 1;
        return {
          stream: convertArrayToReadableStream(
            call === 1
              ? [
                  { type: "text-delta", textDelta: "failed draft" },
                  {
                    type: "error",
                    error: Object.assign(new Error("offline"), { code: "ECONNRESET" }),
                  },
                ]
              : ([
                  { type: "text-delta", textDelta: "committed" },
                  {
                    type: "finish",
                    finishReason: "stop",
                    usage: { promptTokens: 1, completionTokens: 1 },
                  },
                ] as never),
          ),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: config(),
      cwd,
      retryDelayMs: 1,
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(loop, "hi", cwd, false, [], null)).toBe(0);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("committed\n");
    expect(output).not.toContain("failed draft");
  });

  it("returns 130 on SIGINT and flushes the partial response", async () => {
    const backend = {
      onUsage: undefined,
      onHookWarning: undefined,
      async *stream(_input: unknown, signal: AbortSignal): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "partial" };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    } as unknown as AgentLoop;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const running = printMode(backend, "hi", cwd, false, [], null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGINT");

    expect(await running).toBe(130);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("partial\n");
  });
});
