import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import { type CoreMessage, retractLastTurn } from "../src/core/messages";
import { SessionStore } from "../src/session/store";

function makeConfig(): StarConfig {
  return {
    defaultModel: "m",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    permissions: { allow: [] },
  };
}

describe("retractLastTurn", () => {
  it("drops the last user message and everything after it", () => {
    const messages: CoreMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply one" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "reply two" }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", result: "ok" }],
      },
    ];
    const result = retractLastTurn(messages);
    expect(result.removed).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "reply one" }],
    });
  });

  it("retracts again after a previous retraction", () => {
    const once = retractLastTurn([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    const twice = retractLastTurn(once.messages);
    expect(twice.removed).toBe(2);
    expect(twice.messages).toHaveLength(0);
  });

  it("keeps a leading system message and reports zero when there is no user turn", () => {
    const onlySystem: CoreMessage[] = [{ role: "system", content: "sys" }];
    expect(retractLastTurn(onlySystem)).toEqual({ messages: onlySystem, removed: 0 });
    expect(retractLastTurn([])).toEqual({ messages: [], removed: 0 });
  });

  it("retracts a dangling user message with no reply yet", () => {
    const result = retractLastTurn([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "unanswered" },
    ]);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(2);
  });
});

describe("AgentLoop.retractLastTurn", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-retract-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("trims history and persists it to the session store", async () => {
    const store = await SessionStore.create("/tmp/work", "m");
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd: "/tmp/work",
      sessionStore: store,
    });
    await loop.loadMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ]);
    await store.replaceMessages([...loop.getMessages()]);

    expect(await loop.retractLastTurn()).toBe(2);
    expect(loop.getMessages().map((m) => m.role)).toEqual(["system", "user", "assistant"]);

    const persisted = await store.messages();
    expect(persisted.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("returns 0 when there is nothing to retract", async () => {
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd: "/tmp/work",
      sessionStore: null,
    });
    expect(await loop.retractLastTurn()).toBe(0);
  });
});
