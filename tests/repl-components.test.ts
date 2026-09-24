import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderApp, stripAnsi, tick } from "./ink-harness";

// Dynamic imports so ./ink-harness sets FORCE_COLOR before ink is loaded.
const { MessageList } = await import("../src/cli/components/MessageList");
const { RewindConfirmPrompt } = await import("../src/cli/components/RewindConfirmPrompt");
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
        cwd: "/tmp/project",
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
      createElement(StatusBar, {
        cwd: "/tmp/project",
        model: "gpt6",
        permissionMode: "auto",
        tokens: 0,
      }),
    );
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("bg:");
    app.unmount();
  });

  it("truncates long label lists", async () => {
    const long = "x".repeat(80);
    const app = renderApp(
      createElement(StatusBar, {
        cwd: "/tmp/project",
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

describe("RewindConfirmPrompt", () => {
  const diff = {
    label: "f.txt",
    lines: [
      { kind: "del" as const, text: "new line" },
      { kind: "add" as const, text: "old line" },
    ],
  };

  it("renders a custom title, summary, and diff preview", async () => {
    const app = renderApp(
      createElement(RewindConfirmPrompt, {
        title: "Undo last turn",
        confirmLabel: "undo",
        summary: "2 message(s) will be retracted, 1 file change(s) reverted.",
        diffs: [diff],
        onDecision: () => {},
      }),
    );
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("Undo last turn");
    expect(frame).toContain("2 message(s) will be retracted");
    expect(frame).toContain("f.txt");
    expect(frame).toContain("new line");
    expect(frame).toContain("old line");
    expect(frame).toContain("[y] undo [n] cancel");
    app.unmount();
  });

  it("keeps the rewind defaults", async () => {
    const app = renderApp(
      createElement(RewindConfirmPrompt, { summary: "s", onDecision: () => {} }),
    );
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("Rewind checkpoints");
    expect(frame).toContain("[y] rewind [n] cancel");
    app.unmount();
  });

  it("resolves no on n/Esc and yes on y", async () => {
    const decisions: string[] = [];
    const app = renderApp(
      createElement(RewindConfirmPrompt, {
        summary: "s",
        onDecision: (d: string) => decisions.push(d),
      }),
    );
    await tick();
    app.stdin.write("n");
    await tick();
    expect(decisions).toEqual(["no"]);
    app.stdin.write("y");
    await tick();
    expect(decisions).toEqual(["no", "yes"]);
    app.stdin.write("\u001b");
    await tick();
    expect(decisions).toEqual(["no", "yes", "no"]);
    app.unmount();
  });
});
