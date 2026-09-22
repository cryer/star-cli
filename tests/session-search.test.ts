import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import { sessionsDir } from "../src/config/paths";
import type { CoreMessage } from "../src/core/messages";
import { formatSearchResults, searchSessions } from "../src/session/search";
import { SessionStore } from "../src/session/store";

describe("session search", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "star-search-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function makeSession(cwd: string, messages: CoreMessage[]): Promise<SessionStore> {
    const store = await SessionStore.create(cwd, "test-model");
    for (const message of messages) await store.append(message);
    return store;
  }

  it("finds matches across sessions and the snippet contains the match", async () => {
    await makeSession(home, [
      { role: "user", content: "how do I rotate kubernetes secrets?" },
      { role: "assistant", content: "Use a secrets manager." },
    ]);
    const other = await makeSession(home, [
      { role: "user", content: "unrelated question about vim" },
    ]);

    const hits = await searchSessions("kubernetes");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("kubernetes");
    expect(hits.map((h) => h.meta.id)).not.toContain(other.id);
  });

  it("matches case-insensitively", async () => {
    await makeSession(home, [{ role: "user", content: "Hello World" }]);
    const hits = await searchSessions("hello world");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("Hello World");
  });

  it("searches tool-call args and tool-result text", async () => {
    await makeSession(home, [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "read_file",
            args: { path: "src/quantum.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "read_file",
            result: "export const entanglement = true;",
          },
        ],
      },
    ]);
    expect(await searchSessions("quantum.ts")).toHaveLength(1);
    expect(await searchSessions("entanglement")).toHaveLength(1);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await makeSession(home, [{ role: "user", content: `common token message ${i}` }]);
      // Distinct updatedAt ordering is not guaranteed within the same ms;
      // the limit must hold regardless of order.
    }
    const hits = await searchSessions("common token", 3);
    expect(hits).toHaveLength(3);
  });

  it("skips corrupt jsonl lines silently", async () => {
    const store = await makeSession(home, [{ role: "user", content: "valid needle here" }]);
    appendFileSync(
      path.join(sessionsDir(), store.id, "messages.jsonl"),
      "{not valid json\n",
      "utf8",
    );
    const hits = await searchSessions("needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("valid needle here");
  });

  it("returns no hits when nothing matches", async () => {
    await makeSession(home, [{ role: "user", content: "something else" }]);
    expect(await searchSessions("absent")).toEqual([]);
  });

  it("centers long snippets on the match", async () => {
    const pad = "x".repeat(200);
    await makeSession(home, [{ role: "user", content: `${pad} needle ${pad}` }]);
    const [hit] = await searchSessions("needle");
    expect(hit?.snippet).toContain("needle");
    expect(hit?.snippet.length).toBeLessThanOrEqual(110);
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
  });

  it("formatSearchResults renders hits and the resume hint", async () => {
    const store = await makeSession(home, [{ role: "user", content: "find this phrase" }]);
    await store.setTitle("My session");
    const text = formatSearchResults(await searchSessions("phrase"), "phrase");
    expect(text).toContain("My session");
    expect(text).toContain("find this phrase");
    expect(text).toContain("Resume with /resume <id>");
  });

  it("formatSearchResults reports empty results", () => {
    expect(formatSearchResults([], "zzz")).toBe('No sessions matching "zzz".');
  });

  describe("/search command", () => {
    function makeCtx() {
      const calls: { type: string; text?: string }[] = [];
      const ctx = {
        addSystemMessage: (text: string) => calls.push({ type: "system", text }),
      } as unknown as CommandContext;
      return { ctx, calls };
    }

    it("shows usage for an empty query", async () => {
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const { ctx, calls } = makeCtx();
      await registry.get("search")?.run("   ", ctx);
      expect(calls).toEqual([{ type: "system", text: "Usage: /search <query>" }]);
    });

    it("renders hits through the command", async () => {
      const store = await makeSession(home, [{ role: "user", content: "needle in a session" }]);
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const { ctx, calls } = makeCtx();
      await registry.get("search")?.run("needle", ctx);
      const text = calls[0]?.text ?? "";
      expect(text).toContain(store.id.slice(store.id.lastIndexOf("-") + 1));
      expect(text).toContain("(untitled)");
      expect(text).toContain("needle in a session");
      expect(text).toContain("Resume with /resume <id>");
    });

    it("reports when no sessions match", async () => {
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const { ctx, calls } = makeCtx();
      await registry.get("search")?.run("absent", ctx);
      expect(calls).toEqual([{ type: "system", text: 'No sessions matching "absent".' }]);
    });
  });
});
