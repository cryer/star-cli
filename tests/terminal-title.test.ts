import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTitle, setTerminalTitle } from "../src/cli/terminal-title";

function collector() {
  const writes: string[] = [];
  return { writes, write: (text: string) => writes.push(text) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setTerminalTitle", () => {
  it("writes an OSC 0 sequence on a TTY", () => {
    const { writes, write } = collector();
    setTerminalTitle("hello", { write, isTTY: true });
    expect(writes).toEqual(["\x1b]0;hello\x07"]);
  });

  it("does nothing off a TTY", () => {
    const { writes, write } = collector();
    setTerminalTitle("hello", { write, isTTY: false });
    expect(writes).toEqual([]);
  });

  it("strips control characters so the sequence cannot be broken out of", () => {
    const { writes, write } = collector();
    setTerminalTitle("a\x07b\x1bc", { write, isTTY: true });
    expect(writes).toEqual(["\x1b]0;abc\x07"]);
  });
});

describe("TerminalTitle", () => {
  it("spins in the title while running and shows a bell glyph when done", () => {
    vi.useFakeTimers();
    const { writes, write } = collector();
    const title = TerminalTitle.forCwd("/work/proj", {
      write,
      isTTY: true,
      env: { WT_SESSION: "1" },
    });
    title.start();
    expect(writes[0]).toBe("\x1b]0;⠋ star-cli — proj\x07");
    vi.advanceTimersByTime(240);
    expect(writes[writes.length - 1]).toBe("\x1b]0;⠹ star-cli — proj\x07");
    title.stop("done");
    expect(writes[writes.length - 1]).toBe("\x1b]0;🔔 star-cli — proj\x07");
    // No further updates once stopped.
    const count = writes.length;
    vi.advanceTimersByTime(1000);
    expect(writes.length).toBe(count);
  });

  it("falls back to a plain marker without emoji support and restores the base title on idle", () => {
    const { writes, write } = collector();
    const title = TerminalTitle.forCwd("/work/proj", { write, isTTY: true, env: {} });
    title.start();
    title.stop("done");
    expect(writes[writes.length - 1]).toBe("\x1b]0;! star-cli — proj\x07");
    title.stop("idle");
    expect(writes[writes.length - 1]).toBe("\x1b]0;star-cli — proj\x07");
  });

  it("does not start a second interval when already running", () => {
    vi.useFakeTimers();
    const { writes, write } = collector();
    const title = TerminalTitle.forCwd("/work/proj", { write, isTTY: true, env: {} });
    title.start();
    title.start();
    const count = writes.length;
    vi.advanceTimersByTime(120);
    expect(writes.length).toBe(count + 1);
    title.stop("idle");
  });
});
