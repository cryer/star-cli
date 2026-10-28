import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentTasks } from "../src/agent/agent-tasks";
import type { ChatBackend } from "../src/cli/backend";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import type { ChatInput } from "../src/core/messages";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";
import { rmWithRetry } from "./test-fs";

process.env.STAR_NO_UPDATE_CHECK = "1";
const { Repl } = await import("../src/cli/repl");
const { MessageList } = await import("../src/cli/components/MessageList");

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
    notifyBell: false,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: false,
    elisionThresholdFraction: 0.5,
    elisionKeepRecentMessages: 24,
    elisionMinTokens: 250,
    webFetchAllowPrivateHosts: false,
  };
}

function renderRepl(backend: ChatBackend, cwd: string, columns = 80, rows = 12) {
  return renderApp(
    createElement(Repl, {
      backend,
      model: "test",
      permissionMode: "auto",
      config: makeConfig(),
      cwd,
      sessionStore: null,
    }),
    { debug: false, columns, rows },
  );
}

describe("production REPL layout", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-layout-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-layout-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    defaultAgentTasks.cleanup();
    for (const dir of [cwd, home]) await rmWithRetry(dir);
  });

  it("keeps a long streamed fence inside a bounded viewport with a fixed footer", async () => {
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines = Array.from(
      { length: 80 },
      (_, index) => `const line${index + 1} = ${index + 1};`,
    );
    const backend: ChatBackend = {
      async *stream(_input: ChatInput): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: `\`\`\`ts\n${lines.join("\n")}\n\`\`\`` };
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 60, 12);
    await tick();
    await typeText(app.stdin, "go", "\r");
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("line80");
      expect(frame.split("\n").length - 1).toBeLessThanOrEqual(11);
      expect(frame).toContain("mode: auto");
    });
    expect(app.lastFrame()).not.toContain("line1 =");
    expect(app.allOutput()).not.toContain("\u001B[2J");
    release();
    await vi.waitFor(() => {
      const history = stripAnsi(app.allOutput());
      expect(history).toContain("const line1 = 1;");
      expect(history).toContain("const line80 = 80;");
    });
    app.unmount();
  });

  it("keeps a submitted prompt visible by using only the rows the live UI needs", async () => {
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 80, 24);
    await vi.waitFor(() => expect(app.lastFrame() ?? "").toContain("mode: auto"));
    expect((app.lastFrame() ?? "").split("\n").length - 1).toBe(4);

    const beforeSubmit = app.allOutput().length;
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(() => {
      expect(stripAnsi(app.allOutput().slice(beforeSubmit))).toContain("❯ hello");
      expect(app.lastFrame() ?? "").toContain("thinking");
    });
    expect((app.lastFrame() ?? "").split("\n").length - 1).toBeLessThanOrEqual(9);

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    app.unmount();
  });

  it("lays out the footer after shrinking both terminal dimensions", async () => {
    const backend: ChatBackend = { async *stream(): AsyncGenerator<StreamEvent> {} };
    const app = renderRepl(backend, cwd, 100, 24);
    await vi.waitFor(() => expect(app.lastFrame() ?? "").toContain("cache: Not provided"));
    const beforeResize = app.allOutput().length;
    app.resize(32, 8);
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("…");
      expect(frame).not.toContain("cache: Not provided");
      expect(frame.split("\n").length - 1).toBeLessThanOrEqual(7);
    });
    expect(app.allOutput().slice(beforeResize)).not.toContain("\u001B[2J");
    app.unmount();
  });
});

describe("production message history", () => {
  it("appends each message once and does not replay a previous mount", async () => {
    const first = [{ id: 0, role: "system" as const, text: "first history message" }];
    const app = renderApp(createElement(MessageList, { messages: first, termWidth: 80 }), {
      debug: false,
      rows: 12,
    });
    await vi.waitFor(() => expect(app.allOutput()).toContain("first history message"));
    app.rerender(createElement(MessageList, { messages: [...first], termWidth: 80 }));
    await tick();
    expect(stripAnsi(app.allOutput()).match(/first history message/g)).toHaveLength(1);
    const second = [...first, { id: 1, role: "tool" as const, text: "second history message" }];
    app.rerender(createElement(MessageList, { messages: second, termWidth: 80 }));
    await vi.waitFor(() => expect(app.allOutput()).toContain("second history message"));
    expect(stripAnsi(app.allOutput()).match(/second history message/g)).toHaveLength(1);
    const beforeReset = app.allOutput().length;
    app.rerender(
      createElement(MessageList, {
        key: "rewritten",
        messages: [{ id: 2, role: "system" as const, text: "replacement history" }],
        termWidth: 80,
      }),
    );
    await vi.waitFor(() => expect(app.allOutput().length).toBeGreaterThan(beforeReset));
    const rewritten = stripAnsi(app.allOutput().slice(beforeReset));
    expect(rewritten).toContain("replacement history");
    expect(rewritten).not.toContain("first history message");
    expect(rewritten).not.toContain("second history message");
    app.unmount();
  });
});
