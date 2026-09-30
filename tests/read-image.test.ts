import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";
import { readImageTool } from "../src/tools/fs/read-image";

// Minimal PNG header with real dimensions (see tests/image.test.ts).
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// Minimal JPEG with an SOF0 segment carrying real dimensions.
function jpegBuffer(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...new Array<number>(6).fill(0),
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof]);
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "star-read-image-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("read_image tool", () => {
  it("returns the image as an attachment with a descriptive text result", async () => {
    writeFileSync(path.join(cwd, "pic.png"), pngBuffer(320, 200));

    const result = await readImageTool.execute({ path: "pic.png" }, { cwd });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("pic.png");
    expect(result.content).toContain("320x200");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(result.images?.[0]?.data ?? "", "base64")).toEqual(pngBuffer(320, 200));
  });

  it("resolves absolute paths too", async () => {
    const abs = path.join(cwd, "shot.jpg");
    writeFileSync(abs, jpegBuffer(640, 480));

    const result = await readImageTool.execute({ path: abs }, { cwd });

    expect(result.isError).toBeUndefined();
    expect(result.images?.[0]?.mimeType).toBe("image/jpeg");
  });

  it("rejects unsupported extensions, missing files and sensitive paths", async () => {
    writeFileSync(path.join(cwd, "notes.txt"), "hello");
    writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    writeFileSync(path.join(cwd, "fake.png"), "not an image at all");

    const cases = [
      { path: "notes.txt", match: "Not a supported image" },
      { path: "missing.png", match: "File not found" },
      { path: ".env", match: "sensitive" },
      { path: "fake.png", match: "not a valid image" },
    ];
    for (const { path: p, match } of cases) {
      const result = await readImageTool.execute({ path: p }, { cwd });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(match);
      expect(result.images).toBeUndefined();
    }
  });
});

describe("read_image in the agent loop", () => {
  function makeConfig(): StarConfig {
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
    };
  }

  it("appends the image as a user message the next request carries", async () => {
    writeFileSync(path.join(cwd, "pic.png"), pngBuffer(100, 50));
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        prompts.push(options.prompt);
        call++;
        type Chunk =
          | { type: "text-delta"; textDelta: string }
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
            : [
                { type: "text-delta", textDelta: "I see a picture" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { promptTokens: 5, completionTokens: 3 },
                },
              ];
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
    });

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("look at pic.png", new AbortController().signal)) {
      events.push(event);
    }

    const imageMessage = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "image"),
      );
    expect(imageMessage).toBeDefined();
    if (imageMessage && Array.isArray(imageMessage.content)) {
      expect(imageMessage.content).toEqual([
        {
          type: "image",
          image: pngBuffer(100, 50).toString("base64"),
          mimeType: "image/png",
        },
        { type: "text", text: "[image from read_image: pic.png]" },
      ]);
    }

    // The follow-up request must carry the image part to the model.
    const second = prompts[1] as Array<{ role: string; content: unknown }>;
    const promptWithImage = second.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
    );
    expect(promptWithImage).toBeDefined();
  });
});
