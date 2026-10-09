import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, typeText } from "./ink-harness";

const { InputBox } = await import("../src/cli/components/InputBox");
const { filterCommands, filterArgHints, MAX_SUGGESTIONS, didYouMeanSuffix } = await import(
  "../src/cli/commands/suggest"
);

const COMMANDS = [
  { name: "clear", description: "Clear message history" },
  { name: "cost", description: "Show API token usage for this session" },
  { name: "exit", description: "Exit the application" },
  { name: "export", description: "Export the current session to a Markdown file" },
  { name: "help", description: "List available commands" },
  { name: "model", description: "List available models or switch the current model" },
];

const ARG_COMMANDS = [
  {
    name: "model",
    description: "Switch the current model",
    usage: "/model [name]",
    argHints: () => ["gpt-4o", "gpt-4o-mini", "kimi-k2"],
  },
  {
    name: "permission",
    description: "Set the permission mode",
    usage: "/permission [ask|auto|readonly|yolo]",
    argHints: ["ask", "auto", "readonly", "yolo", "plan"],
  },
  { name: "exit", description: "Exit the application" },
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
    expect(result.map((c) => c.name)).toEqual(["clear", "cost", "exit", "export", "help", "model"]);
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

  it("returns every match — the menu windows the display instead of truncating", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, i) => ({
      name: `cmd${i}`,
      description: `desc ${i}`,
    }));
    expect(filterCommands("/", many)).toHaveLength(MAX_SUGGESTIONS + 3);
  });

  it("appends fuzzy subsequence matches after prefix matches", () => {
    const commands = [
      { name: "export", description: "" },
      { name: "exit", description: "" },
      { name: "example", description: "" },
      { name: "complex", description: "" },
    ];
    // "ex" prefixes exit/export/example; complex is a subsequence match.
    expect(filterCommands("/ex", commands).map((c) => c.name)).toEqual([
      "example",
      "exit",
      "export",
      "complex",
    ]);
  });

  it("ranks prefix matches before fuzzy matches even when fuzzy sorts earlier", () => {
    const commands = [
      { name: "hare", description: "" },
      { name: "help", description: "" },
    ];
    // "hare" sorts before "help" but is only a fuzzy (subsequence) match for "he".
    expect(filterCommands("/he", commands).map((c) => c.name)).toEqual(["help", "hare"]);
  });

  it("keeps every prefix and fuzzy match, prefix matches first", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ name: `test${i}`, description: "" }));
    many.push({ name: "tangent", description: "" }, { name: "texture", description: "" });
    const result = filterCommands("/te", many);
    expect(result).toHaveLength(6);
    expect(result.slice(0, 4).map((c) => c.name)).toEqual(["test0", "test1", "test2", "test3"]);
  });

  it("returns nothing when the query is not even a subsequence", () => {
    expect(filterCommands("/zq", COMMANDS)).toEqual([]);
  });
});

describe("filterArgHints", () => {
  it("returns every candidate after the command name plus a space", () => {
    expect(filterArgHints("/permission ", ARG_COMMANDS).map((h) => h.value)).toEqual([
      "ask",
      "auto",
      "readonly",
      "yolo",
      "plan",
    ]);
  });

  it("filters candidates by the current argument prefix, case-insensitively", () => {
    expect(filterArgHints("/permission a", ARG_COMMANDS).map((h) => h.value)).toEqual([
      "ask",
      "auto",
    ]);
    expect(filterArgHints("/permission RE", ARG_COMMANDS).map((h) => h.value)).toEqual([
      "readonly",
    ]);
  });

  it("resolves function sources with the current argument prefix", () => {
    expect(filterArgHints("/model g", ARG_COMMANDS).map((h) => h.value)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("builds the replacement by swapping the trailing token, without a trailing space", () => {
    expect(filterArgHints("/permission a", ARG_COMMANDS)[0]?.replacement).toBe("/permission ask");
    expect(filterArgHints("/permission ", ARG_COMMANDS)[0]?.replacement).toBe("/permission ask");
    expect(filterArgHints("/model gpt-4o k", ARG_COMMANDS)[0]?.replacement).toBe(
      "/model gpt-4o kimi-k2",
    );
  });

  it("returns nothing for commands without argHints or unknown commands", () => {
    expect(filterArgHints("/exit foo", ARG_COMMANDS)).toEqual([]);
    expect(filterArgHints("/zzz foo", ARG_COMMANDS)).toEqual([]);
  });

  it("returns nothing without a space or a leading slash", () => {
    expect(filterArgHints("/permission", ARG_COMMANDS)).toEqual([]);
    expect(filterArgHints("permission a", ARG_COMMANDS)).toEqual([]);
    expect(filterArgHints("", ARG_COMMANDS)).toEqual([]);
  });

  it("returns every candidate — the menu windows the display instead of truncating", () => {
    const commands = [
      {
        name: "model",
        description: "",
        argHints: Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, i) => `m${i}`),
      },
    ];
    expect(filterArgHints("/model ", commands)).toHaveLength(MAX_SUGGESTIONS + 3);
  });
});

describe("didYouMeanSuffix", () => {
  it("returns an empty string without suggestions", () => {
    expect(didYouMeanSuffix([])).toBe("");
  });

  it("lists up to 3 suggestions", () => {
    expect(didYouMeanSuffix(["clear", "cost"])).toBe(" Did you mean: /clear, /cost?");
    expect(didYouMeanSuffix(["a", "b", "c", "d"])).toBe(" Did you mean: /a, /b, /c?");
  });
});

describe("InputBox slash suggestions", () => {
  it('windows the candidates after typing "/" and scrolls to reveal the rest', async () => {
    const { app } = setup();
    await typeText(app.stdin, "/");
    let frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/exit - Exit the application");
    expect(frame).toContain("/help - List available commands");
    expect(frame).not.toContain("/model");
    expect(frame).toContain("more below");
    // Scrolling past the window's end shifts it: /model becomes visible.
    await typeText(app.stdin, DOWN, DOWN, DOWN, DOWN, DOWN);
    frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/model - List available models or switch the current model");
    expect(frame).toContain("more above");
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
    // Mid-text right arrow just moves the cursor: typing after it lands in
    // place ("/exit"), where a completion would have produced "/exitt".
    await typeText(app.stdin, "/exi", LEFT, RIGHT, "t", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/exit");
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
    expect(onSubmit).toHaveBeenNthCalledWith(2, "/exit");
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

  it("renders usage in place of the bare command name when provided", async () => {
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        commands: [
          { name: "resume", description: "Resume a stored session", usage: "/resume [--all] [id]" },
        ],
        onSubmit: () => {},
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    await typeText(app.stdin, "/r");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/resume [--all] [id] - Resume a stored session");
    app.unmount();
  });

  it("runs the highlighted match on enter without tab completion", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/exit");
    app.unmount();
  });

  it("submits the raw text on enter when the menu was dismissed or nothing matches", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/ex", ESCAPE, ENTER);
    expect(onSubmit).toHaveBeenNthCalledWith(1, "/ex");
    await typeText(app.stdin, "/zzz", ENTER);
    expect(onSubmit).toHaveBeenNthCalledWith(2, "/zzz");
    app.unmount();
  });

  it("does not pick a candidate for a bare slash", async () => {
    const { app, onSubmit } = setup();
    await typeText(app.stdin, "/", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/");
    app.unmount();
  });
});

describe("InputBox slash argument suggestions", () => {
  function setupArgs() {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        commands: ARG_COMMANDS,
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    return { app, onSubmit };
  }

  it("offers argument candidates once the input names a command with argHints", async () => {
    const { app } = setupArgs();
    await typeText(app.stdin, "/permission ");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("readonly");
    expect(frame).toContain("yolo");
    app.unmount();
  });

  it("filters argument candidates by the typed prefix", async () => {
    const { app } = setupArgs();
    await typeText(app.stdin, "/permission re");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("readonly");
    expect(frame).not.toContain("yolo");
    app.unmount();
  });

  it("shows no argument candidates for a command without argHints", async () => {
    const { app } = setupArgs();
    await typeText(app.stdin, "/exit no");
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).not.toContain("readonly");
    expect(frame).not.toContain("gpt-4o");
    app.unmount();
  });

  it("completes the highlighted argument on tab and submits the full command", async () => {
    const { app, onSubmit } = setupArgs();
    await typeText(app.stdin, "/permission re", TAB);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("/permission readonly ");
    await typeText(app.stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/permission readonly");
    app.unmount();
  });

  it("completes a function-sourced argument and cycles the highlight", async () => {
    const { app, onSubmit } = setupArgs();
    await typeText(app.stdin, "/model g", DOWN, TAB, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/model gpt-4o-mini");
    app.unmount();
  });

  it("command-name tab completion adds no space; typing one resumes argument hints", async () => {
    const { app, onSubmit } = setupArgs();
    await typeText(app.stdin, "/perm", TAB);
    // No trailing space: the bare command is submittable as-is and the
    // argument hints (which include "plan", absent from the usage string)
    // do not fire yet.
    let frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("/permission [ask|auto|readonly|yolo]");
    expect(frame).not.toContain("plan");
    await typeText(app.stdin, " ");
    frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("plan");
    await typeText(app.stdin, TAB, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/permission ask");
    app.unmount();
  });

  it("completes the highlighted argument on right arrow at end of input", async () => {
    const { app, onSubmit } = setupArgs();
    await typeText(app.stdin, "/permission pla", RIGHT, ENTER);
    expect(onSubmit).toHaveBeenCalledWith("/permission plan");
    app.unmount();
  });
});
