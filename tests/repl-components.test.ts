import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderApp, stripAnsi, tick } from "./ink-harness";

// Dynamic imports so ./ink-harness sets FORCE_COLOR before ink is loaded.
const { MessageList } = await import("../src/cli/components/MessageList");
const { StatusBar } = await import("../src/cli/components/StatusBar");
const { StreamingMessage } = await import("../src/cli/components/StreamingMessage");
const { ThinkingIndicator } = await import("../src/cli/components/ThinkingIndicator");

describe("MessageList continuation chunks", () => {
  it("renders assistant-cont without repeating the star label", async () => {
    const app = renderApp(
      createElement(MessageList, {
        messages: [
          { id: 0, role: "assistant" as const, text: "first chunk", tight: true },
          { id: 1, role: "assistant-cont" as const, text: "second chunk" },
        ],
      }),
    );
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    const starCount = frame.split("star").length - 1;
    expect(starCount).toBe(1);
    expect(frame).toContain("first chunk");
    expect(frame).toContain("second chunk");
    app.unmount();
  });
});

describe("StreamingMessage", () => {
  it("shows the star label by default", async () => {
    const app = renderApp(createElement(StreamingMessage, { text: "hello" }));
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("star");
    app.unmount();
  });

  it("omits the label in continuation mode", async () => {
    const app = renderApp(createElement(StreamingMessage, { text: "tail", continuation: true }));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("star");
    expect(frame).toContain("tail");
    app.unmount();
  });
});

describe("ThinkingIndicator activity", () => {
  it("replaces the default label while a tool is running", async () => {
    const app = renderApp(createElement(ThinkingIndicator, { activity: "running bash: ls" }));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("running bash: ls");
    expect(frame).not.toContain("star is thinking");
    app.unmount();
  });
});

describe("StatusBar background tasks", () => {
  it("shows count and labels while tasks run", async () => {
    const app = renderApp(
      createElement(StatusBar, {
        model: "gpt6",
        permissionMode: "auto",
        tokens: 0,
        backgroundTasks: ["pnpm test"],
      }),
    );
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("bg: 1 (pnpm test)");
    app.unmount();
  });

  it("hides the segment when nothing runs", async () => {
    const app = renderApp(
      createElement(StatusBar, { model: "gpt6", permissionMode: "auto", tokens: 0 }),
    );
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("bg:");
    app.unmount();
  });

  it("truncates long label lists", async () => {
    const long = "x".repeat(80);
    const app = renderApp(
      createElement(StatusBar, {
        model: "gpt6",
        permissionMode: "auto",
        tokens: 0,
        backgroundTasks: [long],
      }),
    );
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("…");
    expect(frame).not.toContain(long);
    app.unmount();
  });
});
