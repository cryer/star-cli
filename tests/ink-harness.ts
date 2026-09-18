import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ReactElement } from "react";

// Force chalk (used by ink) to emit ANSI styles in this non-TTY environment.
// Must run before ink is imported, hence the dynamic import below.
process.env.FORCE_COLOR = "3";
const { render: inkRender } = await import("ink");

export const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
export const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "");

export interface InkApp {
  stdin: { write(s: string): void };
  lastFrame(): string | undefined;
  unmount(): void;
}

// Mirrors ink-testing-library's harness; it cannot be required directly because
// its CJS entry does require("ink") and ink 5 is ESM with top-level await.
export function renderApp(node: ReactElement): InkApp {
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

export async function typeText(stdin: { write(s: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.write(chunk);
    await tick();
  }
}
