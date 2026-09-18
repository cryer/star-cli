import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { render } from "ink";
import type { ReactElement } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

// Force chalk (used by ink) to emit ANSI styles in this non-TTY environment.
// Must run before ink is imported, hence the dynamic imports below.
process.env.FORCE_COLOR = "3";
const { render: inkRender } = await import("ink");
const { InputBox } = await import("../src/cli/components/InputBox");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "");

interface InkApp {
  stdin: { write(s: string): void };
  lastFrame(): string | undefined;
  unmount(): void;
}

// Mirrors ink-testing-library's harness; it cannot be required directly because
// its CJS entry does require("ink") and ink 5 is ESM with top-level await.
function renderApp(node: ReactElement): InkApp {
  let lastFrame: string | undefined;
  const stdout = new EventEmitter() as EventEmitter & {
    write(frame: string): void;
    columns: number;
  };
  stdout.write = (frame: string) => {
    lastFrame = frame;
  };
  stdout.columns = 100;
  const stdin = new Readable({ read() {} }) as Readable & {
    setRawMode(): void;
    isTTY: boolean;
  };
  stdin.setRawMode = () => {};
  stdin.isTTY = true;
  (stdin as unknown as { ref(): void; unref(): void }).ref = () => {};
  (stdin as unknown as { ref(): void; unref(): void }).unref = () => {};
  const instance = inkRender(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
  });
  return {
    stdin: { write: (s: string) => stdin.push(s) },
    lastFrame: () => lastFrame,
    unmount: () => instance.unmount(),
  };
}

function setup() {
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onExit = vi.fn();
  const app = renderApp(
    createElement(InputBox, { isStreaming: false, onSubmit, onInterrupt, onExit }),
  );
  return { app, onSubmit, onInterrupt, onExit };
}

async function type(stdin: { write(s: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.write(chunk);
    await tick();
  }
}

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

describe("InputBox", () => {
  it("submits typed text on enter", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });

  it("inserts in the middle via arrow keys", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "helo", LEFT, "l", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });

  it("backspace deletes the char before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hellxo", LEFT, BACKSPACE, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });

  it("terminal backspace (\\x7f) also deletes the char before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hellxo", LEFT, DELETE, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });

  it("ctrl+u deletes everything before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "say hello world", CTRL_A, RIGHT, RIGHT, RIGHT, RIGHT, CTRL_U, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello world");
    app.unmount();
  });

  it("ctrl+k deletes everything from the cursor to the end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello world", CTRL_A, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, CTRL_K, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    app.unmount();
  });

  it("ctrl+w deletes the previous word before the cursor", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello world", LEFT, CTRL_W, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("hello d");
    app.unmount();
  });

  it("ctrl+a jumps to start and ctrl+e jumps to end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "hello", CTRL_A, "X", CTRL_E, "!", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("Xhello!");
    app.unmount();
  });

  it("history recall places the cursor at the end", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "first", ENTER);
    await type(app.stdin, UP, "!", ENTER);
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
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("draft");
    app.unmount();
  });
});
