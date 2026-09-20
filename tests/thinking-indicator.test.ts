import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderApp, stripAnsi, tick } from "./ink-harness";

// Dynamic import so ./ink-harness sets FORCE_COLOR before ink is loaded.
const { ThinkingIndicator, SPINNER_FRAMES, truncateTail } = await import(
  "../src/cli/components/ThinkingIndicator"
);

describe("truncateTail", () => {
  it("keeps short text unchanged", () => {
    expect(truncateTail("short thought", 200)).toBe("short thought");
  });

  it("collapses whitespace and newlines into single spaces", () => {
    expect(truncateTail("line one\n\nline   two", 200)).toBe("line one line two");
  });

  it("keeps only the tail of long text with an ellipsis prefix", () => {
    const long = "x".repeat(150) + "y".repeat(150);
    const result = truncateTail(long, 200);
    expect(result.startsWith("…")).toBe(true);
    expect(result.length).toBe(201);
    expect(result.endsWith("y".repeat(150))).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(truncateTail("", 200)).toBe("");
  });
});

describe("ThinkingIndicator", () => {
  it("shows the thinking label with an ASCII spinner frame", async () => {
    const app = renderApp(createElement(ThinkingIndicator, {}));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("star is thinking");
    expect(SPINNER_FRAMES.some((f) => frame.includes(f))).toBe(true);
    app.unmount();
  });

  it("streams a dim reasoning tail below the spinner", async () => {
    const app = renderApp(createElement(ThinkingIndicator, { reasoning: "planning next step" }));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("star is thinking");
    expect(frame).toContain("planning next step");
    app.unmount();
  });

  it("truncates a long reasoning tail", async () => {
    const app = renderApp(createElement(ThinkingIndicator, { reasoning: "z".repeat(300) }));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("…");
    expect(frame).not.toContain("z".repeat(300));
    app.unmount();
  });
});
