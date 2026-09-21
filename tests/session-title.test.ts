import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModelV1 } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { SessionStore } from "../src/session/store";
import { generateSessionTitle } from "../src/session/title";
import { createDefaultRegistry } from "../src/tools";

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-title-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-title-cwd-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function generateRound(text: string): LanguageModelV1["doGenerate"] {
  return async () => ({
    text,
    finishReason: "stop",
    usage: { promptTokens: 5, completionTokens: 3 },
    rawCall: { rawPrompt: null, rawSettings: {} },
  });
}

function textStream(text: string): LanguageModelV1["doStream"] {
  return async () => ({
    stream: convertArrayToReadableStream([
      { type: "text-delta", textDelta: text },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  });
}

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
    permissions: { allow: [] },
  };
}

function makeLoop(model: MockLanguageModelV1, store: SessionStore): AgentLoop {
  return new AgentLoop({
    model,
    registry: createDefaultRegistry(),
    config: makeConfig(),
    cwd,
    sessionStore: store,
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

async function waitForTitle(store: SessionStore, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await store.meta();
    if (meta.title) return meta.title;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await store.meta()).title;
}

describe("generateSessionTitle", () => {
  it("strips quotes and trailing punctuation from the model output", async () => {
    const model = new MockLanguageModelV1({ doGenerate: generateRound("“修复登录缺陷”。") });
    expect(await generateSessionTitle("登录页报错了", model)).toBe("修复登录缺陷");
  });

  it("truncates titles longer than 50 characters", async () => {
    const model = new MockLanguageModelV1({ doGenerate: generateRound(`"${"长".repeat(80)}"`) });
    expect(await generateSessionTitle("hi", model)).toBe("长".repeat(50));
  });
});

describe("AgentLoop session title", () => {
  it("generates a title in the background after the first turn", async () => {
    let generateCalls = 0;
    const model = new MockLanguageModelV1({
      doStream: textStream("好的，已修复"),
      doGenerate: async (options) => {
        generateCalls += 1;
        return generateRound("修复登录缺陷")(options);
      },
    });
    const store = await SessionStore.create(cwd, "test-model");
    const loop = makeLoop(model, store);

    const events = await collect(
      loop.stream("帮我修复登录页面的 bug", new AbortController().signal),
    );

    expect(events.some((e) => e.type === "text-delta" && e.text === "好的，已修复")).toBe(true);
    expect(await waitForTitle(store)).toBe("修复登录缺陷");
    expect(generateCalls).toBe(1);
  });

  it("does not regenerate when the session already has a title", async () => {
    let generateCalls = 0;
    const model = new MockLanguageModelV1({
      doStream: textStream("ok"),
      doGenerate: async (options) => {
        generateCalls += 1;
        return generateRound("新标题")(options);
      },
    });
    const store = await SessionStore.create(cwd, "test-model");
    await store.append({ role: "user", content: "之前的问题" });
    await store.setTitle("已有标题");
    const loop = makeLoop(model, store);

    await collect(loop.stream("再说点别的", new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await store.meta()).title).toBe("已有标题");
    expect(generateCalls).toBe(0);
  });

  it("schedules title generation only once per loop", async () => {
    let generateCalls = 0;
    const model = new MockLanguageModelV1({
      doStream: textStream("ok"),
      doGenerate: async (options) => {
        generateCalls += 1;
        return generateRound("标题")(options);
      },
    });
    const store = await SessionStore.create(cwd, "test-model");
    const loop = makeLoop(model, store);

    await collect(loop.stream("第一问", new AbortController().signal));
    expect(await waitForTitle(store)).toBe("标题");
    await collect(loop.stream("第二问", new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(generateCalls).toBe(1);
    expect((await store.meta()).title).toBe("标题");
  });

  it("keeps the turn working when title generation fails", async () => {
    const model = new MockLanguageModelV1({
      doStream: textStream("正常回复"),
      doGenerate: async () => {
        throw new Error("model unavailable");
      },
    });
    const store = await SessionStore.create(cwd, "test-model");
    const loop = makeLoop(model, store);

    const events = await collect(loop.stream("你好", new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.some((e) => e.type === "text-delta" && e.text === "正常回复")).toBe(true);
    expect(events.every((e) => e.type !== "error")).toBe(true);
    expect((await store.meta()).title).toBe("");
  });
});
