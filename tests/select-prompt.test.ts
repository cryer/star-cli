import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

// FORCE_COLOR is set by ./ink-harness before ink is loaded (static import above),
// so this dynamic import of SelectPrompt (which imports ink) sees colored output.
const { SelectPrompt, SELECT_PROMPT_MAX_VISIBLE } = await import(
  "../src/cli/components/SelectPrompt"
);

const UP = "[A";
const DOWN = "[B";
const ENTER = "\r";
const CTRL_X = "\x18";
const ESC = "";

function setup(options: { value: string; label: string; description?: string; hint?: string }[]) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const app = renderApp(
    createElement(SelectPrompt, {
      title: "Pick one",
      options,
      onSelect,
      onCancel,
    }),
  );
  return { app, onSelect, onCancel };
}

const frame = (app: { lastFrame(): string | undefined }) => stripAnsi(app.lastFrame() ?? "");

const simpleOptions = [
  { value: "a", label: "alpha", description: "first option" },
  { value: "b", label: "beta", hint: "current" },
  { value: "c", label: "gamma" },
];

describe("SelectPrompt", () => {
  it("renders title, options, descriptions and hints", async () => {
    const { app } = setup(simpleOptions);
    await tick();
    const out = frame(app);
    expect(out).toContain("Pick one");
    expect(out).toContain("alpha");
    expect(out).toContain("first option");
    expect(out).toContain("beta");
    expect(out).toContain("(current)");
    expect(out).toContain("gamma");
    app.unmount();
  });

  it("highlights the first option initially and moves with arrows", async () => {
    const { app } = setup(simpleOptions);
    await tick();
    expect(frame(app)).toContain("❯ alpha");
    await typeText(app.stdin, DOWN);
    expect(frame(app)).toContain("❯ beta");
    await typeText(app.stdin, UP);
    expect(frame(app)).toContain("❯ alpha");
    app.unmount();
  });

  it("clamps navigation at both ends", async () => {
    const { app } = setup(simpleOptions);
    await typeText(app.stdin, UP, UP);
    expect(frame(app)).toContain("❯ alpha");
    await typeText(app.stdin, DOWN, DOWN, DOWN, DOWN);
    expect(frame(app)).toContain("❯ gamma");
    app.unmount();
  });

  it("supports j/k navigation", async () => {
    const { app } = setup(simpleOptions);
    await typeText(app.stdin, "j");
    expect(frame(app)).toContain("❯ beta");
    await typeText(app.stdin, "k");
    expect(frame(app)).toContain("❯ alpha");
    app.unmount();
  });

  it("fires onSelect with the highlighted value on Enter", async () => {
    const { app, onSelect } = setup(simpleOptions);
    await typeText(app.stdin, DOWN, ENTER);
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("b"));
    app.unmount();
  });

  it("fires onCancel on Esc", async () => {
    const { app, onCancel, onSelect } = setup(simpleOptions);
    await typeText(app.stdin, ESC);
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled();
    app.unmount();
  });

  it("caps visible rows and shows truncation indicators", async () => {
    const options = Array.from({ length: SELECT_PROMPT_MAX_VISIBLE + 4 }, (_, i) => ({
      value: `v${i}`,
      label: `option-${String(i).padStart(2, "0")}`,
    }));
    const { app } = setup(options);
    await tick();
    let out = frame(app);
    expect(out).toContain("option-00");
    expect(out).toContain("… 4 more below");
    expect(out).not.toContain(`option-${SELECT_PROMPT_MAX_VISIBLE}`);
    await typeText(app.stdin, ...Array(SELECT_PROMPT_MAX_VISIBLE + 4).fill(DOWN));
    out = frame(app);
    expect(out).toContain("more above");
    expect(out).toContain(`❯ option-${options.length - 1}`);
    expect(out).not.toContain("more below");
    app.unmount();
  });
});

describe("SelectPrompt deletion (Ctrl+X)", () => {
  function setupDelete(
    options: { value: string; label: string }[],
    onDelete = vi.fn(async (value: string) => options.filter((o) => o.value !== value)),
  ) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const element = (opts: { value: string; label: string }[]) =>
      createElement(SelectPrompt, {
        title: "Pick one",
        options: opts,
        onSelect,
        onCancel,
        onDelete,
      });
    const app = renderApp(element(options));
    return { app, onSelect, onCancel, onDelete, element };
  }

  it("shows the [Ctrl+X] delete hint only when onDelete is set", async () => {
    const { app } = setupDelete(simpleOptions);
    await tick();
    expect(frame(app)).toContain("[Ctrl+X] delete");
    app.unmount();

    const { app: plain } = setup(simpleOptions);
    await tick();
    expect(frame(plain)).not.toContain("[Ctrl+X] delete");
    plain.unmount();
  });

  it("Ctrl+X asks for confirmation and n cancels without deleting", async () => {
    const { app, onDelete } = setupDelete(simpleOptions);
    await tick();
    await typeText(app.stdin, CTRL_X);
    expect(frame(app)).toContain("Delete alpha? [y] yes [n] no");
    await typeText(app.stdin, "n");
    expect(frame(app)).toContain("[Ctrl+X] delete");
    expect(onDelete).not.toHaveBeenCalled();
    app.unmount();
  });

  it("Esc cancels the confirmation instead of the picker", async () => {
    const { app, onDelete, onCancel } = setupDelete(simpleOptions);
    await tick();
    await typeText(app.stdin, CTRL_X, ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(frame(app)).toContain("[Ctrl+X] delete");
    app.unmount();
  });

  it("y confirms and deletes the highlighted option", async () => {
    const { app, onDelete } = setupDelete(simpleOptions);
    await tick();
    await typeText(app.stdin, DOWN, CTRL_X);
    expect(frame(app)).toContain("Delete beta? [y] yes [n] no");
    await typeText(app.stdin, "y");
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("b"));
    app.unmount();
  });

  it("clamps the highlight after the last option is deleted", async () => {
    const { app, element } = setupDelete(simpleOptions);
    await tick();
    await typeText(app.stdin, DOWN, DOWN, CTRL_X, "y");
    await tick();
    // The parent re-renders with the remaining options (repl.tsx setPicker).
    app.rerender(element(simpleOptions.slice(0, 2)));
    await tick();
    expect(frame(app)).toContain("❯ beta");
    app.unmount();
  });

  it("ignores navigation keys while the confirmation is open", async () => {
    const { app, onDelete } = setupDelete(simpleOptions);
    await tick();
    await typeText(app.stdin, CTRL_X, DOWN, "j");
    expect(frame(app)).toContain("Delete alpha? [y] yes [n] no");
    expect(onDelete).not.toHaveBeenCalled();
    app.unmount();
  });
});
