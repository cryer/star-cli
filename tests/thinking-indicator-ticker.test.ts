import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, tick } from "./ink-harness";

// Pin the icon set: the label icon depends on terminal detection otherwise.
vi.stubEnv("STAR_ICONS", "plain");

// Wrap the real startTicker to track whether every returned stop function
// runs — the indicator must stop its interval when it unmounts.
const tickerStops: { called: boolean }[] = [];
vi.mock("../src/cli/ticker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/cli/ticker")>();
  return {
    ...original,
    startTicker: (onTick: (tick: number) => void, intervalMs?: number) => {
      const stop = original.startTicker(onTick, intervalMs);
      const tracker = { called: false };
      tickerStops.push(tracker);
      return () => {
        tracker.called = true;
        stop();
      };
    },
  };
});

// Dynamic import so ./ink-harness sets FORCE_COLOR before ink is loaded.
const { ThinkingIndicator, SPINNER_FRAMES } = await import(
  "../src/cli/components/ThinkingIndicator"
);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ThinkingIndicator self-driven ticker", () => {
  it("animates the spinner without a frame prop", async () => {
    const app = renderApp(createElement(ThinkingIndicator, {}));
    await tick();
    const first = app.lastFrame() ?? "";
    expect(stripAnsi(first)).toContain(`${SPINNER_FRAMES[0]} ✧ star is thinking`);
    await wait(250); // > two 100ms ticks
    const later = app.lastFrame() ?? "";
    expect(later).not.toBe(first);
    expect(stripAnsi(later)).toContain("star is thinking");
    app.unmount();
  });

  it("shows the elapsed clock from startedAt once past 3s", async () => {
    const app = renderApp(createElement(ThinkingIndicator, { startedAt: Date.now() - 4000 }));
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("(4s)");
    app.unmount();
  });

  it("hides the elapsed clock below 3s", async () => {
    const app = renderApp(createElement(ThinkingIndicator, { startedAt: Date.now() }));
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toMatch(/\(\d+[smh]/);
    app.unmount();
  });

  it("stops its ticker when unmounted", async () => {
    tickerStops.length = 0;
    const app = renderApp(createElement(ThinkingIndicator, {}));
    await tick();
    expect(tickerStops.length).toBeGreaterThan(0);
    app.unmount();
    // Passive-effect cleanups flush asynchronously after unmount.
    await tick();
    expect(tickerStops.every((tracker) => tracker.called)).toBe(true);
  });
});
