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
