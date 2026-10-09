import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import {
  ELIDED_IMAGE_TEXT,
  ELIDED_TOOL_CALL_ARGS_TEXT,
  ELIDED_TOOL_RESULT_TEXT,
  elideStaleContent,
} from "../src/context/elision";
import type { CoreMessage, StarMessage } from "../src/core/messages";
import { createDefaultRegistry } from "../src/tools";

const system = (text: string): CoreMessage => ({ role: "system", content: text });
const user = (text: string): CoreMessage => ({ role: "user", content: text });
const assistant = (text: string): CoreMessage => ({ role: "assistant", content: text });
const toolCallAssistant = (id: string): CoreMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", args: { path: "a.ts" } }],
});
const toolResult = (id: string, result: unknown): CoreMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", result }],
});

const star = (messages: CoreMessage[]): StarMessage[] => messages.map((message) => ({ message }));

// cl100k: one "x" run of 400 chars ≈ 50 tokens, so 4000 chars ≈ 500.
const bigText = "x".repeat(4000);

describe("elideStaleContent", () => {
  it("does nothing below the activation fraction", () => {
    const messages = star([system("sys"), toolResult("c1", bigText), user("hi")]);
    expect(elideStaleContent(messages, 100_000)).toBeNull();
  });

  it("elides old large tool results but keeps the pairing and a placeholder", () => {
    const messages = star([
      system("sys"),
      toolCallAssistant("c1"),
      toolResult("c1", bigText),
      ...Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`))),
    ]);
    // 500+ tokens of results vs a 800 threshold: over the 50% activation.
    const result = elideStaleContent(messages, 800);
    expect(result).not.toBeNull();
    expect(result?.elidedCount).toBe(1);
    const elidedMsg = result?.messages[2]?.message;
    expect(elidedMsg?.role).toBe("tool");
    if (elidedMsg?.role === "tool") {
      expect(elidedMsg.content[0]?.toolCallId).toBe("c1");
      expect(elidedMsg.content[0]?.result).toBe(ELIDED_TOOL_RESULT_TEXT);
    }
    expect(result?.messages[2]?.meta?.elided).toBe(true);
    // Message count and order are untouched — turn indices stay valid.
    expect(result?.messages.length).toBe(messages.length);
  });

  it("keeps large results inside the recent-message frontier", () => {
    const messages = star([
      system("sys"),
      ...Array.from({ length: 20 }, (_, i) => user(`u${i}`)),
      toolCallAssistant("c1"),
      toolResult("c1", bigText),
      user("latest"),
    ]);
    expect(elideStaleContent(messages, 800)).toBeNull();
  });

  it("keeps small old results — they are cheaper than a re-run", () => {
    const messages = star([
      system("sys"),
      toolCallAssistant("c1"),
      toolResult("c1", "short output"),
      ...Array.from({ length: 30 }, (_, i) => user(`u${i}`)),
    ]);
    expect(elideStaleContent(messages, 50)).toBeNull();
  });

  it("replaces old image parts with a text placeholder, keeping sibling text", () => {
    const withImage: CoreMessage = {
      role: "user",
      content: [
        { type: "image", image: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "what is this?" },
      ],
    };
    const messages = star([
      system("sys"),
      withImage,
      toolResult("c1", bigText),
      ...Array.from({ length: 30 }, (_, i) => user(`u${i}`)),
    ]);
    const result = elideStaleContent(messages, 800);
    expect(result).not.toBeNull();
    const elidedMsg = result?.messages[1]?.message;
    if (elidedMsg?.role === "user" && Array.isArray(elidedMsg.content)) {
      expect(elidedMsg.content[0]).toEqual({ type: "text", text: ELIDED_IMAGE_TEXT });
      expect(elidedMsg.content[1]).toEqual({ type: "text", text: "what is this?" });
    } else {
      throw new Error("expected a user message with array content");
    }
  });

  it("is idempotent — already-elided messages are left alone", () => {
    const messages = star([
      system("sys"),
      toolCallAssistant("c1"),
      toolResult("c1", bigText),
      ...Array.from({ length: 30 }, (_, i) => user(`u${i}`)),
    ]);
    const first = elideStaleContent(messages, 800);
    expect(first).not.toBeNull();
    expect(elideStaleContent(first?.messages ?? [], 800)).toBeNull();
  });

  const bigArgsCall = (id: string): CoreMessage => ({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "write_file",
        args: { path: "a.ts", content: bigText },
      },
    ],
  });

  it("guts old tool-call arguments but keeps the call id and name", () => {
    const messages = star([
      system("sys"),
      bigArgsCall("c1"),
      toolResult("c1", "ok"),
      ...Array.from({ length: 30 }, (_, i) => user(`u${i}`)),
    ]);
    const result = elideStaleContent(messages, 800);
    expect(result).not.toBeNull();
    expect(result?.elidedCount).toBe(1);
    const elidedMsg = result?.messages[1]?.message;
    expect(elidedMsg?.role).toBe("assistant");
    if (elidedMsg?.role === "assistant" && Array.isArray(elidedMsg.content)) {
      const part = elidedMsg.content[0];
      expect(part?.type).toBe("tool-call");
      if (part?.type === "tool-call") {
        // Pairing survives: same id and name, only the args are replaced.
        expect(part.toolCallId).toBe("c1");
        expect(part.toolName).toBe("write_file");
        expect(part.args).toEqual({ elided: ELIDED_TOOL_CALL_ARGS_TEXT });
      }
    }
    expect(result?.messages[1]?.meta?.elided).toBe(true);
    expect(result?.messages.length).toBe(messages.length);
  });

  it("keeps big tool-call arguments inside the recent-message frontier", () => {
    const messages = star([
      system("sys"),
      ...Array.from({ length: 20 }, (_, i) => user(`u${i}`)),
      bigArgsCall("c1"),
      toolResult("c1", "ok"),
      user("latest"),
    ]);
    expect(elideStaleContent(messages, 800)).toBeNull();
  });

  it("keeps small old tool-call arguments — gutting them saves nothing", () => {
    const messages = star([
      system("sys"),
      toolCallAssistant("c1"),
      toolResult("c1", bigText),
      ...Array.from({ length: 30 }, (_, i) => user(`u${i}`)),
    ]);
    const result = elideStaleContent(messages, 800);
    // Only the big tool result is elided; the tiny read_file call stays whole.
    expect(result?.elidedCount).toBe(1);
    const kept = result?.messages[1]?.message;
    if (kept?.role === "assistant" && Array.isArray(kept.content)) {
      const part = kept.content[0];
      if (part?.type === "tool-call") {
        expect(part.args).toEqual({ path: "a.ts" });
      }
    }
  });
});

describe("elision in the agent loop", () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-elision-"));
    // Isolate from the real ~/.star-cli — a developer's MEMORY.md would
    // otherwise leak into the system prompt these tests assert on.
    home = mkdtempSync(path.join(tmpdir(), "star-elision-home-"));
    vi.stubEnv("STAR_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("shrinks stale bulk before compaction, keeping every turn in place", async () => {
    const config = {
      providers: [],
      models: [],
      maxSteps: 50,
      contextMaxTokens: 10_000,
      contextCompaction: "truncate",
      streamIdleTimeoutSec: 20,
      streamFirstChunkTimeoutSec: 300,
      streamMaxRetries: 1,
      maxAutoContinues: 0,
      doomLoopThreshold: 3,
      permissionMode: "auto",
      permissions: { allow: [], deny: [], ask: [] },
      gitSnapshots: false,
      hooks: [],
    } as unknown as StarConfig;
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-delta", textDelta: "ok" },
          { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model: model as never,
      registry: createDefaultRegistry(),
      config,
      cwd,
      retryDelayMs: 1,
    });

    // 15 big old tool results (≈7.8K tokens) + 30 filler messages: over the
    // 10K window with the tool-schema overhead, so whole-turn compaction
    // would fire — unless elision shrinks the stale bulk first.
    const history: CoreMessage[] = [system("sys")];
    for (let i = 0; i < 15; i++) {
      history.push(toolCallAssistant(`c${i}`), toolResult(`c${i}`, bigText));
    }
    for (let i = 0; i < 30; i++) {
      history.push(i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`));
    }
    await loop.loadMessages(history);

    const events: { type: string }[] = [];
    for await (const event of loop.stream("hi", new AbortController().signal)) {
      events.push(event);
    }

    const messages = loop.getMessages();
    // Whole-turn compaction never fired: no compaction placeholder, and the
    // opening turns are all still there.
    expect(
      messages.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith("[context compacted:"),
      ),
    ).toBe(false);
    expect(messages[0]?.content).toBe("sys");
    // The stale results became placeholders instead.
    const elided = messages.filter(
      (m) => m.role === "tool" && m.content[0]?.result === ELIDED_TOOL_RESULT_TEXT,
    );
    expect(elided.length).toBe(15);
  });
});
