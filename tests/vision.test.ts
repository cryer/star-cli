import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import {
  IMAGE_UNSUPPORTED_PLACEHOLDER,
  isVisionUnsupportedError,
  stripAllImages,
} from "../src/core/image";
import type { CoreMessage } from "../src/core/messages";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { readImageTool } from "../src/tools/fs/read-image";
import { createScreenshotTool } from "../src/tools/screenshot";
import { rmWithRetry } from "./test-fs";

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "error"; error: unknown }
  | {
      type: "tool-call";
      toolCallType: "function";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      type: "finish";
      finishReason: "stop" | "tool-calls";
      usage: { promptTokens: number; completionTokens: number };
    };

function textRound(text: string): Chunk[] {
  return [
    { type: "text-delta", textDelta: text },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } },
  ];
}

function apiError(message: string, statusCode: number): Error {
  const error = new Error(message);
  error.name = "AI_APICallError";
  (error as unknown as { statusCode: number }).statusCode = statusCode;
  return error;
}

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const SMALL_PNG = pngBuffer(100, 100).toString("base64");

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    streamFirstChunkTimeoutSec: 300,
    streamMaxRetries: 3,
    maxAutoContinues: 2,
    notifyBell: true,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: false,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("isVisionUnsupportedError", () => {
  it("matches text-only endpoint rejections", () => {
    const cases = [
      "this server was started without the vision encoder (run setup again and choose 'vision'), so it cannot read images",
      "This model does not support images",
      "multimodal input is not supported by this model",
      "Invalid request: image input is not supported for this model",
    ];
    for (const message of cases) {
      expect(isVisionUnsupportedError(apiError(message, 400)), message).toBe(true);
    }
  });

  it("rejects non-4xx, oversized-image and unrelated errors", () => {
    expect(isVisionUnsupportedError(apiError("server error: no vision encoder", 500))).toBe(false);
    expect(
      isVisionUnsupportedError(
        apiError("At least one of the image dimensions exceed max allowed size", 400),
      ),
    ).toBe(false);
    expect(isVisionUnsupportedError(apiError("invalid request: bad tool schema", 400))).toBe(false);
    expect(isVisionUnsupportedError(new Error("network down"))).toBe(false);
  });
});

describe("stripAllImages", () => {
  it("replaces every image part with the unsupported placeholder", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "plain text" },
      {
        role: "user",
        content: [
          { type: "image", image: SMALL_PNG, mimeType: "image/png" },
          { type: "text", text: "caption" },
          { type: "image", image: SMALL_PNG, mimeType: "image/png" },
        ],
      },
    ];
    const { messages: stripped, removed } = stripAllImages(messages);
    expect(removed).toBe(2);
    expect(stripped[0]).toBe(messages[0]);
    const content = stripped[1]?.content;
    expect(Array.isArray(content) && content[0]).toEqual({
      type: "text",
      text: IMAGE_UNSUPPORTED_PLACEHOLDER,
    });
    expect(Array.isArray(content) && content[1]).toEqual({ type: "text", text: "caption" });
    // The input array is not mutated.
    expect(JSON.stringify(messages[1])).toContain(SMALL_PNG);
  });

  it("returns the same array and zero when there is nothing to strip", () => {
    const messages: CoreMessage[] = [{ role: "user", content: "no images" }];
    const { messages: stripped, removed } = stripAllImages(messages);
    expect(removed).toBe(0);
    expect(stripped).toBe(messages);
  });
});

describe("vision-disabled tools", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-vision-tool-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("read_image declines with a text error and attaches nothing", async () => {
    writeFileSync(path.join(cwd, "pic.png"), pngBuffer(100, 50));

    const result = await readImageTool.execute({ path: "pic.png" }, { cwd, visionEnabled: false });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not support image input");
    expect(result.images).toBeUndefined();
  });

  it("screenshot declines without invoking the capture", async () => {
    let captured = false;
    const tool = createScreenshotTool(async () => {
      captured = true;
      return { ok: false as const, error: "should not run" };
    });

    const result = await tool.execute({}, { cwd, visionEnabled: false });

    expect(captured).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not support image input");
    expect(result.images).toBeUndefined();
  });
});

describe("vision handling in the agent loop", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-vision-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-vision-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmWithRetry(cwd);
    await rmWithRetry(home);
  });

  it("strips every image and retries when the endpoint cannot read images", async () => {
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        prompts.push(options.prompt);
        calls++;
        const chunks: Chunk[] =
          calls === 1
            ? [
                {
                  type: "error",
                  error: apiError(
                    "this server was started without the vision encoder (run setup again and choose 'vision'), so it cannot read images",
                    400,
                  ),
                },
              ]
            : textRound("done");
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
      retryDelayMs: 1,
    });

    const events = await collect(
      loop.stream(
        { text: "look", images: [{ path: "small.png", mimeType: "image/png", data: SMALL_PNG }] },
        new AbortController().signal,
      ),
    );

    expect(calls).toBe(2);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    if (notice?.type === "notice") {
      expect(notice.message).toContain("Removed 1 image(s) the model cannot read");
    }
    expect(events.some((e) => e.type === "error")).toBe(false);

    // In-memory history carries the placeholder instead of the image.
    const user = loop.getMessages().find((m) => m.role === "user");
    expect(Array.isArray(user?.content) && user.content[0]).toEqual({
      type: "text",
      text: IMAGE_UNSUPPORTED_PLACEHOLDER,
    });

    // The retried request carried no image parts.
    const second = prompts[1] as Array<{ role: string; content: unknown }>;
    expect(
      second.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
      ),
    ).toBe(false);

    // The stripped history is what a resume would load.
    const persisted = await store.messages();
    expect(JSON.stringify(persisted)).toContain(IMAGE_UNSUPPORTED_PLACEHOLDER);
    expect(JSON.stringify(persisted)).not.toContain(SMALL_PNG);
  });

  it("fails immediately when the vision error has no images left to strip", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream([
            {
              type: "error",
              error: apiError("This model does not support images", 400),
            } satisfies Chunk,
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      retryDelayMs: 1,
    });

    const events = await collect(loop.stream("hello", new AbortController().signal));

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("read_image returns a text error and no image enters the history when vision is false", async () => {
    writeFileSync(path.join(cwd, "pic.png"), pngBuffer(100, 50));
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call++;
        const chunks: Chunk[] =
          call === 1
            ? [
                {
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "c1",
                  toolName: "read_image",
                  args: JSON.stringify({ path: "pic.png" }),
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { promptTokens: 5, completionTokens: 3 },
                },
              ]
            : textRound("no vision, working from text");
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      vision: false,
      retryDelayMs: 1,
    });

    const events = await collect(loop.stream("look at pic.png", new AbortController().signal));

    expect(call).toBe(2);
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("does not support image input");
    }
    expect(
      loop
        .getMessages()
        .some(
          (m) =>
            Array.isArray(m.content) &&
            (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
        ),
    ).toBe(false);
  });
});
