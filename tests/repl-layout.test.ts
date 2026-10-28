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
const { Box, Text } = await import("ink");

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

  it("keeps a submitted prompt visible above a full-height fixed footer", async () => {
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
    expect((app.lastFrame() ?? "").split("\n").length - 1).toBe(23);
    const idleFooterRow = stripAnsi(app.lastFrame() ?? "")
      .split("\n")
      .findIndex((line) => line.includes("mode: auto"));

    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(() => {
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("❯ hello");
      expect(app.lastFrame() ?? "").toContain("thinking");
    });
    expect((app.lastFrame() ?? "").split("\n").length - 1).toBe(23);
    const streamingFooterRow = stripAnsi(app.lastFrame() ?? "")
      .split("\n")
      .findIndex((line) => line.includes("mode: auto"));
    expect(streamingFooterRow).toBe(idleFooterRow);

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    app.unmount();
  });

  it("keeps thinking visible and the footer stationary across stream commits", async () => {
    let sendSecond = () => {};
    let release = () => {};
    const second = new Promise<void>((resolve) => {
      sendSecond = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "first chunk\n" };
        await second;
        yield {
          type: "text-delta",
          text: Array.from({ length: 20 }, (_, index) => `output ${index + 1}`).join("\n"),
        };
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 80, 20);
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("first chunk"));
    const firstFrame = stripAnsi(app.lastFrame() ?? "");
    const footerRow = firstFrame.split("\n").findIndex((line) => line.includes("mode: auto"));
    expect(firstFrame).toContain("star is thinking");

    sendSecond();
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("output 20"));
    const streamingFrame = stripAnsi(app.lastFrame() ?? "");
    expect(streamingFrame).toContain("star is thinking");
    expect(streamingFrame.split("\n").findIndex((line) => line.includes("mode: auto"))).toBe(
      footerRow,
    );
    expect(streamingFrame.split("\n").length - 1).toBe(19);

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("output 20");
    app.unmount();
  });

  it("does not archive a growing reply into Static output mid-stream", async () => {
    let sendSecond = () => {};
    let release = () => {};
    const second = new Promise<void>((resolve) => {
      sendSecond = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "first chunk\n" };
        await second;
        yield {
          type: "text-delta",
          text: Array.from({ length: 20 }, (_, index) => `output ${index + 1}`).join("\n"),
        };
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 80, 20);
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("first chunk"));
    const beforeSecond = app.writes().length;

    sendSecond();
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("output 20"));
    const staticWrites = app
      .writes()
      .slice(beforeSecond)
      .filter((write) => write.includes("output 1") && !write.includes("mode: auto"));
    expect(staticWrites).toHaveLength(0);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("star is thinking");

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    expect(stripAnsi(app.allOutput())).toContain("output 1");
    app.unmount();
  });

  it("keeps todos attached to the input while a picker opens and closes", async () => {
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield {
          type: "tool-call",
          id: "todo-call",
          name: "todo_write",
          args: {
            todos: [
              { id: 1, title: "first task", status: "in_progress" },
              { id: 2, title: "second task", status: "pending" },
            ],
          },
        };
        yield {
          type: "tool-result",
          id: "todo-call",
          name: "todo_write",
          content: "Todo list updated.",
        };
        yield { type: "text-delta", text: "working" };
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const config = makeConfig();
    config.providers.push({
      name: "provider",
      protocol: "openai-compatible",
      baseURL: "https://example.invalid",
      apiKey: "test-key",
    });
    config.models.push(
      { name: "test", provider: "provider", model: "model-one" },
      { name: "other", provider: "provider", model: "model-two" },
    );
    const app = renderApp(
      createElement(Repl, {
        backend,
        model: "test",
        permissionMode: "auto",
        config,
        cwd,
        sessionStore: null,
      }),
      { debug: false, columns: 80, rows: 24 },
    );
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(() => {
      const frame = stripAnsi(app.lastFrame() ?? "");
      expect(frame).toContain("second task");
      expect(frame).toContain("working");
      expect(frame).toContain("star is thinking");
    });
    const activeRows = stripAnsi(app.lastFrame() ?? "").split("\n");
    const thinkingRow = activeRows.findIndex((line) => line.includes("star is thinking"));
    const firstTodoRow = activeRows.findIndex((line) => line.includes("first task"));
    const activeInputRow = activeRows.findIndex((line) => line.includes("│ ❯"));
    expect(thinkingRow).toBeGreaterThanOrEqual(0);
    expect(firstTodoRow).toBeGreaterThan(thinkingRow);
    expect(activeInputRow).toBeGreaterThan(firstTodoRow);

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("star is thinking"));
    const rowsBefore = stripAnsi(app.lastFrame() ?? "").split("\n");
    const positionsBefore = {
      output: rowsBefore.findIndex((line) => line.includes("working")),
      todo: rowsBefore.findIndex((line) => line.includes("second task")),
      input: rowsBefore.findIndex((line) => line.includes("│ ❯")),
      status: rowsBefore.findIndex((line) => line.includes("mode: auto")),
    };
    expect(positionsBefore.input - positionsBefore.todo).toBe(2);

    await typeText(app.stdin, "/model", "\r");
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("Select a model"));
    const pickerRows = stripAnsi(app.lastFrame() ?? "").split("\n");
    const pickerFrame = pickerRows.join("\n");
    const pickerInput = pickerRows.findIndex((line) => line.includes("│ ❯"));
    expect(pickerInput - pickerRows.findIndex((line) => line.includes("second task"))).toBe(2);
    expect(pickerRows.findIndex((line) => line.includes("Select a model"))).toBeGreaterThan(
      pickerInput,
    );
    expect(pickerFrame).toContain("◐ first task");
    expect(pickerFrame).toContain("○ second task");

    await typeText(app.stdin, "\u001B");
    await vi.waitFor(() =>
      expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("Select a model"),
    );
    const rowsAfter = stripAnsi(app.lastFrame() ?? "").split("\n");
    expect({
      output: rowsAfter.findIndex((line) => line.includes("working")),
      todo: rowsAfter.findIndex((line) => line.includes("second task")),
      input: rowsAfter.findIndex((line) => line.includes("│ ❯")),
      status: rowsAfter.findIndex((line) => line.includes("mode: auto")),
    }).toEqual(positionsBefore);
    app.unmount();
  });

  it("uses the full viewport for recent tool results between model steps", async () => {
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        for (const [index, name] of ["one", "two", "three"].entries()) {
          yield {
            type: "tool-call",
            id: `call-${index}`,
            name: "read_file",
            args: { path: `src/${name}.js` },
          };
          yield {
            type: "tool-result",
            id: `call-${index}`,
            name: "read_file",
            content: `${name} tool output`,
          };
        }
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 80, 24);
    await typeText(app.stdin, "inspect", "\r");
    await vi.waitFor(() => {
      const frame = stripAnsi(app.lastFrame() ?? "");
      expect(frame).toContain("three tool output");
      expect(frame).toContain("star is thinking");
    });
    const frame = stripAnsi(app.lastFrame() ?? "");
    for (const name of ["one", "two", "three"]) {
      expect(frame).toContain(`src/${name}.js`);
      expect(frame).toContain(`${name} tool output`);
    }
    expect(frame).toContain("star is thinking");
    expect(frame.split("\n").findIndex((line) => line.includes("❯ inspect"))).toBe(0);
    expect(frame.split("\n").findIndex((line) => line.includes("mode: auto"))).toBe(22);

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    app.unmount();
  });

  it("keeps the tail of a long tool result visible after later output", async () => {
    let release = () => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield {
          type: "tool-call",
          id: "long-call",
          name: "read_file",
          args: { path: "src/long.js" },
        };
        yield {
          type: "tool-result",
          id: "long-call",
          name: "read_file",
          content: Array.from({ length: 30 }, (_, index) => `long output ${index + 1}`).join("\n"),
        };
        yield { type: "text-delta", text: "Checking the next file." };
        yield {
          type: "tool-call",
          id: "short-call",
          name: "grep",
          args: { pattern: "TODO" },
        };
        yield {
          type: "tool-result",
          id: "short-call",
          name: "grep",
          content: "latest output",
        };
        await finished;
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const app = renderRepl(backend, cwd, 80, 20);
    await typeText(app.stdin, "inspect", "\r");
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("latest output"));
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("long output 10");
    expect(frame).toContain("Checking the next file.");
    expect(frame).toContain("latest output");

    release();
    await vi.waitFor(() => expect(app.lastFrame() ?? "").not.toContain("thinking"));
    app.unmount();
  });

  it("keeps the scrolling model picker below the input and above the status bar", async () => {
    const config = makeConfig();
    config.providers.push({
      name: "provider",
      protocol: "openai-compatible",
      baseURL: "https://example.invalid",
      apiKey: "test-key",
    });
    config.models.push(
      { name: "test", provider: "provider", model: "model-one" },
      ...Array.from({ length: 13 }, (_, index) => ({
        name: `model-${String(index + 1).padStart(2, "0")}`,
        provider: "provider",
        model: `model-${index + 1}`,
      })),
    );
    const backend: ChatBackend = { async *stream(): AsyncGenerator<StreamEvent> {} };
    const app = renderApp(
      createElement(Repl, {
        backend,
        model: "test",
        permissionMode: "auto",
        config,
        cwd,
        sessionStore: null,
        initialMessages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "reply" },
        ],
      }),
      { debug: false, columns: 80, rows: 24 },
    );
    await typeText(app.stdin, "/model", "\r");
    await vi.waitFor(() => {
      const frame = stripAnsi(app.lastFrame() ?? "");
      expect(frame).toContain("Select a model");
      expect(frame).toContain("❯ test");
      expect(frame).toContain("more below");
      expect(frame).toContain("[Enter] select");
      expect(frame).toContain("mode: auto");
    });
    const initialLines = stripAnsi(app.lastFrame() ?? "").split("\n");
    const inputRow = initialLines.findIndex((line) => line.includes("│ ❯"));
    const pickerRow = initialLines.findIndex((line) => line.includes("Select a model"));
    const statusRow = initialLines.findIndex((line) => line.includes("mode: auto"));
    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(pickerRow).toBeGreaterThan(inputRow);
    expect(statusRow).toBeGreaterThan(pickerRow);
    expect(statusRow).toBe(22);

    await typeText(app.stdin, ...Array(config.models.length - 1).fill("\u001B[B"));
    await vi.waitFor(() => {
      const scrolled = stripAnsi(app.lastFrame() ?? "");
      expect(scrolled).toContain("❯ model-13");
      expect(scrolled).toContain("more above");
      expect(scrolled).not.toContain("more below");
      expect(scrolled).toContain("[Enter] select");
    });
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
  it("uses only the height of the visible tail instead of reserving a blank viewport", async () => {
    const app = renderApp(
      createElement(
        Box,
        { flexDirection: "column", height: 12 },
        createElement(MessageList, {
          messages: [{ id: 0, role: "user", text: "short" }],
          termWidth: 80,
          maxLines: 10,
        }),
        createElement(Text, null, "thinking"),
      ),
      { debug: false, rows: 12 },
    );
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("thinking"));
    const lines = stripAnsi(app.lastFrame() ?? "").split("\n");
    expect(lines.findIndex((line) => line.includes("thinking"))).toBe(2);
    app.unmount();
  });

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
