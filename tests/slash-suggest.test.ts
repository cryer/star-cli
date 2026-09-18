import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, typeText } from "./ink-harness";

const { InputBox } = await import("../src/cli/components/InputBox");
const { filterCommands, MAX_SUGGESTIONS } = await import("../src/cli/commands/suggest");

const COMMANDS = [
  { name: "clear", description: "Clear message history" },
  { name: "cost", description: "Show API token usage for this session" },
  { name: "exit", description: "Exit the application" },
  { name: "export", description: "Export the current session to a Markdown file" },
  { name: "help", description: "List available commands" },
  { name: "model", description: "List available models or switch the current model" },
];

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const ESCAPE = "\u001B";
const TAB = "\t";
const ENTER = "\r";

function setup() {
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onExit = vi.fn();
  const app = renderApp(
    createElement(InputBox, {
      isStreaming: false,
      commands: COMMANDS,
      onSubmit,
      onInterrupt,
      onExit,
    }),
  );
  return { app, onSubmit, onInterrupt, onExit };
}

describe("filterCommands", () => {
  it('returns all commands sorted for "/"', () => {
    const result = filterCommands("/", COMMANDS);
    expect(result.map((c) => c.name)).toEqual(["clear", "cost", "exit", "export", "help"]);
  });

  it("filters by case-insensitive prefix", () => {
    expect(filterCommands("/ex", COMMANDS).map((c) => c.name)).toEqual(["exit", "export"]);
    expect(filterCommands("/EX", COMMANDS).map((c) => c.name)).toEqual(["exit", "export"]);
  });

  it("returns nothing when the input does not start with /", () => {
    expect(filterCommands("hello", COMMANDS)).toEqual([]);
    expect(filterCommands("", COMMANDS)).toEqual([]);
  });

  it("returns nothing once the input contains whitespace", () => {
    expect(filterCommands("/exit foo", COMMANDS)).toEqual([]);
  });

  it("returns nothing when no command matches", () => {
    expect(filterCommands("/zzz", COMMANDS)).toEqual([]);
  });

  it("truncates to MAX_SUGGESTIONS", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, i) => ({
      name: `cmd${i}`,
      description: `desc ${i}`,
    }));
    expect(filterCommands("/", many)).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("InputBox slash suggestions", () => {
  it('shows all candidates after typing "/"', async () => {
    const { app } = setup();
    await typeText(app.stdin, "/");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/exit - Exit the application");
    expect(frame).toContain("/help - List available commands");
    expect(frame).not.toContain("/model");
    app.unmount();
  });

  it('filters candidates as the user types "/ex"', async () => {
    const { app } = setup();
    await typeText(app.stdin, "/ex");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/exit - Exit the application");
    expect(frame).toContain("/export - Export the current session");
    expect(frame).not.toContain("/help - List available commands");
    app.unmount();
  });

  it("does not show candidates for regular text", async () => {
    const { app } = setup();
    await typeText(app.stdin, "hello");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("Exit the application");
    app.unmount();
  });

  it("hides candidates when nothing matches", async () => {
    const { app } = setup();
    await typeText(app.stdin, "/zzz");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("Exit the application");
    app.unmount();
  });

  it("completes the highlighted candidate on tab", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", TAB, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/exit");
    app.unmount();
  });

  it("completes the highlighted candidate on right arrow at end of input", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", RIGHT, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/exit");
    app.unmount();
  });

  it("does not complete on right arrow when the cursor is not at the end", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", LEFT, RIGHT, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/ex");
    app.unmount();
  });

  it("moves the highlight with down/up and wraps around", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", DOWN, TAB, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/export");

    await typeText(app.stdin, "/ex", DOWN, DOWN, TAB, ENTER);
    expect(onSubmit).toHaveBeenNthCalledWith(2, "/exit");

    await typeText(app.stdin, "/ex", UP, TAB, ENTER);
    expect(onSubmit).toHaveBeenNthCalledWith(3, "/export");
    app.unmount();
  });

  it("renders the highlighted candidate in inverse", async () => {
    const { app } = setup();
    await typeText(app.stdin, "/ex");
    const frame = app.lastFrame() ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
    expect(frame).toMatch(/\u001B\[7m\u001B\[1m\/exit - Exit the application/);
    app.unmount();
  });

  it("does not recall history with up/down while candidates are visible", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "first", ENTER);
    await typeText(app.stdin, "/ex", UP, DOWN, ENTER);
    expect(onSubmit).toHaveBeenNthCalledWith(2, "/ex");
    app.unmount();
  });

  it("dismisses candidates on escape and shows them again on the next keystroke", async () => {
    const { app } = setup();
    await typeText(app.stdin, "/ex", ESCAPE);
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("Exit the application");
    await typeText(app.stdin, "i");
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("/exit - Exit the application");
    app.unmount();
  });

  it("submits the typed text on enter without picking a candidate", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/ex");
    app.unmount();
  });
});
