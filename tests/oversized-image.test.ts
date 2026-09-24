import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { IMAGE_REMOVED_PLACEHOLDER, MAX_IMAGE_DIMENSION } from "../src/core/image";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      finishReason: "stop";
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

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

const OVERSIZED_PNG = pngBase64(MAX_IMAGE_DIMENSION + 500, 300);
const SMALL_PNG = pngBase64(100, 100);

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

describe("oversized image retry", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-image-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-image-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function makeLoop(
    model: MockLanguageModelV1,
    sessionStore: SessionStore | null = null,
  ): AgentLoop {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore,
      retryDelayMs: 1,
    });
  }

  function multimodalInput() {
    return {
      text: "what are these?",
      images: [
        { path: "big.png", mimeType: "image/png", data: OVERSIZED_PNG },
        { path: "small.png", mimeType: "image/png", data: SMALL_PNG },
      ],
    };
  }

  it("strips oversized images, retries the request, and persists the stripped history", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        const chunks: Chunk[] =
          calls === 1
            ? [
                {
                  type: "error",
                  error: apiError(
                    "At least one of the image dimensions exceed max allowed size: 8000 pixels",
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
    const loop = makeLoop(model, store);

    const events = await collect(loop.stream(multimodalInput(), new AbortController().signal));

    expect(calls).toBe(2);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    if (notice?.type === "notice") {
      expect(notice.message).toContain("Removed 1 oversized image");
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "retry")).toBe(false);

    const user = loop.getMessages().find((m) => m.role === "user");
    expect(Array.isArray(user?.content) && user.content[0]).toEqual({
      type: "text",
      text: IMAGE_REMOVED_PLACEHOLDER,
    });
    expect(Array.isArray(user?.content) && user.content[1]).toEqual({
      type: "image",
      image: SMALL_PNG,
      mimeType: "image/png",
    });

    const persisted = await store.messages();
    const persistedUser = persisted.find((m) => m.role === "user");
    expect(JSON.stringify(persistedUser)).toContain(IMAGE_REMOVED_PLACEHOLDER);
    expect(JSON.stringify(persistedUser)).not.toContain(OVERSIZED_PNG);
  });

  it("fails through the normal error path when the stripped request still fails", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream([
            { type: "error", error: apiError("image too large", 400) } satisfies Chunk,
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    const events = await collect(loop.stream(multimodalInput(), new AbortController().signal));

    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.message).toContain("image too large");
    }
  });

  it("does not strip images for unrelated 4xx errors", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream([
            {
              type: "error",
              error: apiError("invalid request: bad tool schema", 400),
            } satisfies Chunk,
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    const events = await collect(loop.stream(multimodalInput(), new AbortController().signal));

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("error");
    const user = loop.getMessages().find((m) => m.role === "user");
    expect(Array.isArray(user?.content) && user.content[0]).toMatchObject({ type: "image" });
  });

  it("fails without retrying when no oversized image is left to strip", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream([
            {
              type: "error",
              error: apiError("image dimensions exceed the limit", 400),
            } satisfies Chunk,
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    const events = await collect(
      loop.stream(
        { text: "look", images: [{ path: "small.png", mimeType: "image/png", data: SMALL_PNG }] },
        new AbortController().signal,
      ),
    );

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("error");
  });
});
