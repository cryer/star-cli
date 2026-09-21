import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

// FORCE_COLOR is set by ./ink-harness before ink is loaded (static import above),
// so this dynamic import of InputBox (which imports ink) sees colored output.
const { InputBox } = await import("../src/cli/components/InputBox");

function setup() {
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onExit = vi.fn();
  const app = renderApp(
    createElement(InputBox, { isStreaming: false, onSubmit, onInterrupt, onExit }),
  );
  return { app, onSubmit, onInterrupt, onExit };
}

const type = typeText;

const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const UP = "\u001B[A";
const BACKSPACE = "\b";
const DELETE = "\x7f";
const CTRL_A = "\x01";
const CTRL_C = "\x03";
const CTRL_E = "\x05";
const CTRL_K = "\x0b";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const ENTER = "\r";

const submitted = (onSubmit: ReturnType<typeof vi.fn>, text: string) =>
  vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(text));

describe("InputBox", () => {
  it("submits typed text on enter", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello", ENTER);
    await submitted(onSubmit, "hello");
    app.unmount();
  });

  it("inserts in the middle via arrow keys", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "helo", LEFT, "l", ENTER);
    await submitted(onSubmit, "hello");
    app.unmount();
  });

  it("backspace deletes the char before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hellxo", LEFT, BACKSPACE, ENTER);
    await submitted(onSubmit, "hello");
    app.unmount();
  });

  it("terminal backspace (\\x7f) also deletes the char before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hellxo", LEFT, DELETE, ENTER);
    await submitted(onSubmit, "hello");
    app.unmount();
  });

  it("ctrl+u deletes everything before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "say hello world", CTRL_A, RIGHT, RIGHT, RIGHT, RIGHT, CTRL_U, ENTER);
    await submitted(onSubmit, "hello world");
    app.unmount();
  });

  it("ctrl+k deletes everything from the cursor to the end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello world", CTRL_A, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, CTRL_K, ENTER);
    await submitted(onSubmit, "hello");
    app.unmount();
  });

  it("ctrl+w deletes the previous word before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello world", LEFT, CTRL_W, ENTER);
    await submitted(onSubmit, "hello d");
    app.unmount();
  });

  it("ctrl+a jumps to start and ctrl+e jumps to end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello", CTRL_A, "X", CTRL_E, "!", ENTER);
    await submitted(onSubmit, "Xhello!");
    app.unmount();
  });

  it("history recall places the cursor at the end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "first", ENTER);
    await type(app.stdin, UP, "!", ENTER);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenNthCalledWith(1, "first");
    expect(onSubmit).toHaveBeenNthCalledWith(2, "first!");
    app.unmount();
  });

  it("renders an inverse cursor at end of line", async () => {
    const { app } = setup();
    await type(app.stdin, "hi");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("\u001B[7m \u001B[27m");
    expect(stripAnsi(frame)).toContain("hi");
    app.unmount();
  });

  it("ctrl+c clears the input when idle", async () => {
    const { app, onInterrupt } = setup();
    await type(app.stdin, "draft", CTRL_C, ENTER);
    await tick();
    await tick();
    await tick();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("draft");
    app.unmount();
  });
});
