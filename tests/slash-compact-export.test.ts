import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModelV1 } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { compactSession, exportSession, renderSessionMarkdown } from "../src/cli/commands/actions";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import type { StarConfig } from "../src/config/schema";
import type { CoreMessage } from "../src/core/messages";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";

const pad = (n: number) => "x".repeat(n);
const user = (text: string): CoreMessage => ({ role: "user", content: text });
const assistant = (text: string): CoreMessage => ({ role: "assistant", content: text });

function generateRound(text: string): LanguageModelV1["doGenerate"] {
  return async () => ({
    text,
    finishReason: "stop",
    usage: { promptTokens: 5, completionTokens: 3 },
    rawCall: { rawPrompt: null, rawSettings: {} },
  });
}

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 90,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    permissions: { allow: [] },
    hooks: [],
    ...overrides,
  };
}

function longHistory(): CoreMessage[] {
  return [
    user(pad(400)),
    assistant(pad(400)),
    user("u2"),
    assistant("a2"),
    user("u3"),
    assistant("a3"),
  ];
}

describe("slash /compact and /export", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-cwd-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(
    model: MockLanguageModelV1,
    sessionStore: SessionStore | null = null,
    configOverrides: Partial<StarConfig> = {},
  ) {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(configOverrides),
      cwd,
      sessionStore,
    });
  }

  describe("/compact", () => {
    it("does nothing on an empty or short history", async () => {
      const store = await SessionStore.create(cwd, "test");
      const loop = makeLoop(new MockLanguageModelV1({ doGenerate: generateRound("s") }), store);
      await loop.loadMessages([user("hi"), assistant("hello")]);

      const result = await compactSession({
        backend: loop,
        sessionStore: store,
        config: makeConfig(),
        model: null,
      });

      expect(result.compacted).toBe(false);
      expect(result.message).toContain("Nothing to compact");
      expect(loop.getMessages()).toHaveLength(2);
      expect(fs.existsSync(store.dir)).toBe(false);
    });

    it("reports no-op when history is below the token threshold", async () => {
      const loop = makeLoop(new MockLanguageModelV1({ doGenerate: generateRound("s") }));
      await loop.loadMessages([
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
      ]);

      const result = await compactSession({
        backend: loop,
        sessionStore: null,
        config: makeConfig({ contextMaxTokens: 100_000 }),
        model: null,
      });

      expect(result.compacted).toBe(false);
      expect(result.message).toContain("below the limit");
      expect(loop.getMessages()).toHaveLength(5);
    });

    it("shrinks the history with an LLM summary and syncs the session store", async () => {
      const store = await SessionStore.create(cwd, "test");
      const model = new MockLanguageModelV1({ doGenerate: generateRound("SUMMARY TEXT") });
      const loop = makeLoop(model, store);
      const history = longHistory();
      await loop.loadMessages(history);
      for (const message of history) await store.append(message);
      expect(await store.messages()).toHaveLength(history.length);

      const result = await compactSession({
        backend: loop,
        sessionStore: store,
        config: makeConfig(),
        model,
      });

      expect(result.compacted).toBe(true);
      expect(result.message).toContain("Compacted context: 6 -> 5 messages");
      const next = loop.getMessages();
      expect(next.length).toBeLessThan(history.length);
      expect(next[0]?.content).toBe("[earlier conversation summarized]\nSUMMARY TEXT");
      expect(await store.messages()).toEqual([...next]);
    });

    it("falls back to the truncation placeholder when summarization fails", async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          throw new Error("summary unavailable");
        },
      });
      const loop = makeLoop(model);
      await loop.loadMessages(longHistory());

      const result = await compactSession({
        backend: loop,
        sessionStore: null,
        config: makeConfig(),
        model,
      });

      expect(result.compacted).toBe(true);
      expect(loop.getMessages()[0]?.content).toBe(
        "[context compacted: 2 earlier messages dropped]",
      );
    });

    it("dispatches to ctx.compactContext", async () => {
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const calls: string[] = [];
      const ctx = {
        addSystemMessage: (text: string) => calls.push(text),
        compactContext: async () => "compact done",
      } as unknown as CommandContext;

      await registry.get("compact")?.run("", ctx);

      expect(calls).toEqual(["compact done"]);
    });
  });

  describe("/export", () => {
    it("does not write a file for an empty session", async () => {
      const store = await SessionStore.create(cwd, "test");
      const loop = makeLoop(new MockLanguageModelV1({ doGenerate: generateRound("s") }), store);

      const message = await exportSession({ backend: loop, sessionStore: store, cwd, arg: "" });

      expect(message).toContain("Nothing to export");
      expect(fs.readdirSync(cwd)).toEqual([]);
    });

    it("writes valid Markdown to the default path", async () => {
      const store = await SessionStore.create(cwd, "test");
      const loop = makeLoop(new MockLanguageModelV1({ doGenerate: generateRound("s") }), store);
      await loop.loadMessages([
        user("please list files"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "listing files" },
            { type: "tool-call", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "bash", result: "a.txt\nb.txt" },
          ],
        },
        assistant("found a.txt and b.txt"),
      ]);

      const message = await exportSession({ backend: loop, sessionStore: store, cwd, arg: "" });

      const target = path.join(cwd, `star-session-${store.id}.md`);
      expect(message).toBe(`Exported 4 messages to ${target}.`);
      const markdown = fs.readFileSync(target, "utf8");
      expect(markdown).toContain(`# Star CLI Session ${store.id}`);
      expect(markdown).toContain("_Exported at ");
      expect(markdown).toContain("## User\n\nplease list files");
      expect(markdown).toContain("## Assistant\n\nlisting files");
      expect(markdown).toContain('**Tool call: bash**\n\n```json\n{\n  "command": "ls"\n}\n```');
      expect(markdown).toContain("## Tool\n\n**Tool result: bash**\n\n```\na.txt\nb.txt\n```");
    });

    it("writes to a user-supplied path and reports overwrites", async () => {
      const store = await SessionStore.create(cwd, "test");
      const loop = makeLoop(new MockLanguageModelV1({ doGenerate: generateRound("s") }), store);
      await loop.loadMessages([user("hi"), assistant("hello")]);

      const first = await exportSession({
        backend: loop,
        sessionStore: store,
        cwd,
        arg: "out/notes.md",
      });
      const target = path.join(cwd, "out", "notes.md");
      expect(first).toBe(`Exported 2 messages to ${target}.`);
      expect(fs.existsSync(target)).toBe(true);

      const second = await exportSession({
        backend: loop,
        sessionStore: store,
        cwd,
        arg: "out/notes.md",
      });
      expect(second).toBe(`Exported 2 messages to ${target} (overwrote existing file).`);
    });

    it("dispatches args to ctx.exportSession", async () => {
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const calls: string[] = [];
      const seen: string[] = [];
      const ctx = {
        addSystemMessage: (text: string) => calls.push(text),
        exportSession: async (p: string) => {
          seen.push(p);
          return "exported";
        },
      } as unknown as CommandContext;

      await registry.get("export")?.run("out.md", ctx);

      expect(seen).toEqual(["out.md"]);
      expect(calls).toEqual(["exported"]);
    });
  });

  describe("renderSessionMarkdown", () => {
    it("renders string and structured content with a fixed timestamp", () => {
      const markdown = renderSessionMarkdown(
        "s1",
        [user("hello"), assistant("hi there")],
        new Date("2025-01-02T03:04:05.000Z"),
      );
      expect(markdown).toBe(
        [
          "# Star CLI Session s1",
          "",
          "_Exported at 2025-01-02T03:04:05.000Z_",
          "",
          "## User",
          "",
          "hello",
          "",
          "## Assistant",
          "",
          "hi there",
          "",
        ].join("\n"),
      );
    });
  });
});
