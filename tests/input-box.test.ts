import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

// FORCE_COLOR is set by ./ink-harness before ink is loaded (static import above),
// so this dynamic import of InputBox (which imports ink) sees colored output.
const { InputBox, PASTE_MERGE_WINDOW_MS } = await import("../src/cli/components/InputBox");

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
const DOWN = "\u001B[B";
const BACKSPACE = "\b";
const DELETE = "\x7f";
const CTRL_A = "\x01";
const CTRL_C = "\x03";
const CTRL_G = "\x07";
const CTRL_R = "\x12";
const ESC = "\u001B";
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

  it("recalls initialHistory entries with the up arrow", async () => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        initialHistory: ["older command", "newer command"],
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("newer command");
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("older command");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "older command");
    app.unmount();
  });

  it("up/down switch between pristine history entries and back to the draft", async () => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        initialHistory: ["one", "two"],
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("two");
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("one");
    await type(app.stdin, DOWN);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("two");
    await type(app.stdin, DOWN);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("two");
    expect(frame).not.toContain("one");
    app.unmount();
  });

  it("editing a recalled entry ends history browsing; up recalls history again", async () => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        initialHistory: ["one"],
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await type(app.stdin, UP, "x");
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("onex");
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("one");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "one");
    app.unmount();
  });

  it("up/down move the cursor between lines of multi-line input", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "ab", "\n", "xyz");
    await type(app.stdin, UP, "Z", ENTER);
    await submitted(onSubmit, "abZ\nxyz");
    app.unmount();
  });

  it("down restores the column clamped to the shorter line", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "ab", "\n", "xyz");
    await type(app.stdin, UP, DOWN, "W", ENTER);
    await submitted(onSubmit, "ab\nxyWz");
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

  it("accepts typed input while streaming (the parent queues it)", async () => {
    const onSubmit = vi.fn();
    const onInterrupt = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: true,
        onSubmit,
        onInterrupt,
        onExit: () => {},
      }),
    );
    await type(app.stdin, "next prompt", ENTER);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("next prompt"));
    app.unmount();
  });

  it("alt+v and ctrl+v trigger clipboard image paste", async () => {
    for (const keySeq of ["\x1bv", "\x16"]) {
      const onPasteImage = vi.fn();
      const app = renderApp(
        createElement(InputBox, {
          isStreaming: false,
          onSubmit: () => {},
          onInterrupt: () => {},
          onExit: () => {},
          onPasteImage,
        }),
      );
      await type(app.stdin, keySeq);
      await vi.waitFor(() => expect(onPasteImage).toHaveBeenCalled());
      app.unmount();
    }
  });

  it("ctrl+j inserts a newline instead of submitting", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "line1", "\n", "line2", ENTER);
    await submitted(onSubmit, "line1\nline2");
    app.unmount();
  });

  it("backslash + enter inserts a newline instead of submitting", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "line1", "\\", ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    await type(app.stdin, "line2", ENTER);
    await submitted(onSubmit, "line1\nline2");
    app.unmount();
  });

  it("slash command submissions stay out of the history", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "/q", ENTER);
    await submitted(onSubmit, "/q");
    await type(app.stdin, "real", ENTER);
    await submitted(onSubmit, "real");
    await type(app.stdin, UP);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("real");
    expect(frame).not.toContain("/q");
    app.unmount();
  });

  it("history recall does not get stuck on a slash-command entry", async () => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        commands: [{ name: "q", description: "quit" }],
        initialHistory: ["real command", "/q"],
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("/q");
    // The recalled "/q" activates the slash suggestion menu, but up must
    // keep navigating history instead of cycling the single suggestion.
    await type(app.stdin, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("real command");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "real command");
    app.unmount();
  });

  it("pasted CRLF line endings normalize to \\n", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "a\r\nb", ENTER);
    await submitted(onSubmit, "a\nb");
    app.unmount();
  });

  const pasteLines = (count: number, prefix = "log line") =>
    Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");

  it("collapses a large multi-line paste into a placeholder", async () => {
    const { app } = setup();
    await type(app.stdin, pasteLines(20));
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 20 lines]");
    expect(frame).not.toContain("log line 20");
    app.unmount();
  });

  it("expands the placeholder back to the full text on submit", async () => {
    const { app, onSubmit } = setup();
    const big = pasteLines(20);
    await type(app.stdin, big, ENTER);
    await submitted(onSubmit, big);
    app.unmount();
  });

  it("collapses a long single-line paste by character count", async () => {
    const { app, onSubmit } = setup();
    const big = "x".repeat(600);
    await type(app.stdin, big);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("[pasted #1: 1 line]");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, big);
    app.unmount();
  });

  it("inserts a small multi-line paste directly without a placeholder", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "line1\nline2");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    expect(frame).not.toContain("[pasted");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "line1\nline2");
    app.unmount();
  });

  it("backspace deletes a placeholder as a unit", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, "x", pasteLines(20));
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("[pasted #1: 20 lines]");
    await type(app.stdin, BACKSPACE);
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("[pasted");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "x");
    app.unmount();
  });

  it("collapses multiple pastes and expands each on submit", async () => {
    const { app, onSubmit } = setup();
    const a = pasteLines(12, "alpha");
    const b = pasteLines(12, "beta");
    await type(app.stdin, a, " mid ", b);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 12 lines]");
    expect(frame).toContain("[pasted #2: 12 lines]");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, `${a} mid ${b}`);
    app.unmount();
  });

  it("resets placeholder numbering after a submit", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, pasteLines(15), ENTER);
    await submitted(onSubmit, pasteLines(15));
    await type(app.stdin, pasteLines(11));
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("[pasted #1: 11 lines]");
    app.unmount();
  });

  const PASTE_START = "\u001B[200~";
  const PASTE_END = "\u001B[201~";

  it("merges a paste split across input events into one placeholder", async () => {
    const { app, onSubmit } = setup();
    const chunk1 = `${pasteLines(12, "chunk a")}\n`;
    const chunk2 = `${pasteLines(6, "chunk b")}\n`;
    const chunk3 = pasteLines(4, "chunk c");
    await type(app.stdin, chunk1);
    await type(app.stdin, chunk2);
    await type(app.stdin, chunk3);
    const merged = chunk1 + chunk2 + chunk3;
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain(`[pasted #1: ${merged.split("\n").length} lines]`);
    expect(frame).not.toContain("[pasted #2");
    expect(frame).not.toContain("chunk c 4");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, merged);
    app.unmount();
  });

  it("merges paste chunks delivered in a single stdin drain", async () => {
    const { app, onSubmit } = setup();
    const chunk1 = `${pasteLines(12, "drain a")}\n`;
    const chunk2 = `${pasteLines(6, "drain b")}\n`;
    const chunk3 = pasteLines(4, "drain c");
    app.stdin.write(chunk1);
    app.stdin.write(chunk2);
    app.stdin.write(chunk3);
    await tick();
    await tick();
    const merged = chunk1 + chunk2 + chunk3;
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1:");
    expect(frame).not.toContain("[pasted #2");
    expect(frame).not.toContain("drain c 4");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, merged);
    app.unmount();
  });

  it("collapses a bracketed paste that arrives in one event", async () => {
    const { app, onSubmit } = setup();
    const big = pasteLines(20);
    await type(app.stdin, `${PASTE_START}${big}${PASTE_END}`);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 20 lines]");
    expect(frame).not.toContain("log line 20");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, big);
    app.unmount();
  });

  it("buffers a bracketed paste split across events and keeps trailing typed text", async () => {
    const { app, onSubmit } = setup();
    const big = pasteLines(30);
    const cut = 100;
    await type(app.stdin, PASTE_START);
    await type(app.stdin, big.slice(0, cut));
    await type(app.stdin, `${big.slice(cut)}${PASTE_END}`);
    await type(app.stdin, "tail");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 30 lines]");
    expect(frame).toContain("tail");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, `${big}tail`);
    app.unmount();
  });

  it("recognizes a bracket end marker split across two events", async () => {
    const { app, onSubmit } = setup();
    const big = pasteLines(15);
    await type(app.stdin, `${PASTE_START}${big}\u001B[20`);
    await type(app.stdin, "1~");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, big);
    app.unmount();
  });

  it("flushes the buffered paste when a key arrives before the end marker", async () => {
    const { app } = setup();
    const big = pasteLines(15);
    await type(app.stdin, `${PASTE_START}${big}`);
    await type(app.stdin, LEFT);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 15 lines]");
    app.unmount();
  });

  it("inserts a small bracketed paste verbatim and normalizes CRLF", async () => {
    const { app, onSubmit } = setup();
    await type(app.stdin, `${PASTE_START}line1\r\nline2${PASTE_END}`);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    expect(frame).not.toContain("[pasted");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, "line1\nline2");
    app.unmount();
  });

  it("does not swallow text typed right after a collapsed paste", async () => {
    const { app, onSubmit } = setup();
    const big = pasteLines(12);
    await type(app.stdin, big);
    await type(app.stdin, "note");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 12 lines]");
    expect(frame).toContain("note");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, `${big}note`);
    app.unmount();
  });

  it("does not merge a paste-like input after the merge window", async () => {
    const { app, onSubmit } = setup();
    const first = pasteLines(12);
    const later = pasteLines(6, "later");
    await type(app.stdin, first);
    await new Promise((resolve) => setTimeout(resolve, PASTE_MERGE_WINDOW_MS + 100));
    await type(app.stdin, later);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("[pasted #1: 12 lines]");
    expect(frame).toContain("later 6");
    await type(app.stdin, ENTER);
    await submitted(onSubmit, `${first}${later}`);
    app.unmount();
  });

  it("renders multi-line input with the cursor after the last char", async () => {
    const { app } = setup();
    await type(app.stdin, "first", "\n", "sec");
    const frame = app.lastFrame() ?? "";
    expect(stripAnsi(frame)).toContain("first");
    expect(stripAnsi(frame)).toContain("sec");
    expect(frame).toContain("sec\u001B[7m \u001B[27m");
    app.unmount();
  });

  it("keeps the cursor attached to the text end when the input soft-wraps", async () => {
    const { app } = setup();
    await type(app.stdin, "a".repeat(110));
    const frame = app.lastFrame() ?? "";
    // The inverse cursor must directly follow the final typed character —
    // not stranded on its own line by independently-wrapping Text nodes.
    expect(frame).toContain("a\u001B[7m \u001B[27m");
    app.unmount();
  });

  const setupSearch = (initialHistory: string[]) => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        initialHistory,
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    return { app, onSubmit };
  };

  it("ctrl+r enters reverse search and shows the newest match for the query", async () => {
    const { app } = setupSearch(["git status", "npm test", "git commit"]);
    await type(app.stdin, CTRL_R, "git");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("(reverse-search) 'git': git commit");
    app.unmount();
  });

  it("ctrl+r again jumps to the next older match, down returns to the newer one", async () => {
    const { app } = setupSearch(["git status", "npm test", "git commit"]);
    await type(app.stdin, CTRL_R, "git", CTRL_R);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("(reverse-search) 'git': git status");
    await type(app.stdin, DOWN);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("(reverse-search) 'git': git commit");
    app.unmount();
  });

  it("matching is case-insensitive and stops at the oldest match", async () => {
    const { app } = setupSearch(["GIT status", "git commit"]);
    await type(app.stdin, CTRL_R, "git", UP, UP);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("(reverse-search) 'git': GIT status");
    app.unmount();
  });

  it("enter accepts the match into the input for editing and submitting", async () => {
    const { app, onSubmit } = setupSearch(["git status", "git commit"]);
    await type(app.stdin, CTRL_R, "git", ENTER);
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("(reverse-search)");
    await type(app.stdin, "!", ENTER);
    await submitted(onSubmit, "git commit!");
    app.unmount();
  });

  it("shows 'no match' and enter with no match restores the original input", async () => {
    const { app } = setupSearch(["one", "two"]);
    await type(app.stdin, "keep", CTRL_R, "zzz");
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("no match");
    await type(app.stdin, ENTER);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("(reverse-search)");
    expect(frame).toContain("keep");
    app.unmount();
  });

  it("esc cancels the search and restores the original input and cursor", async () => {
    const { app, onSubmit } = setupSearch(["one", "two"]);
    await type(app.stdin, "draft", LEFT, LEFT, CTRL_R, "o", ESC);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("(reverse-search)");
    expect(frame).toContain("draft");
    // Cursor was two from the end before the search; typing lands there.
    await type(app.stdin, "X", ENTER);
    await submitted(onSubmit, "draXft");
    app.unmount();
  });

  it("ctrl+g also cancels the search", async () => {
    const { app } = setupSearch(["one", "two"]);
    await type(app.stdin, "draft", CTRL_R, "o", CTRL_G);
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("(reverse-search)");
    expect(frame).toContain("draft");
    app.unmount();
  });

  it("ctrl+r does not enter search mode while streaming", async () => {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: true,
        initialHistory: ["one"],
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await type(app.stdin, CTRL_R);
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("(reverse-search)");
    app.unmount();
  });
});
