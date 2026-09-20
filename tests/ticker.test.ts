import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_MS, nextFlush, startTicker } from "../src/cli/ticker";

describe("nextFlush", () => {
  it("returns null when nothing changed", () => {
    const prev = { streamed: "hello", reasoning: "thinking" };
    expect(nextFlush(prev, { streamed: "hello", reasoning: "thinking" })).toBeNull();
  });

  it("returns the next state when the streamed text changed", () => {
    const prev = { streamed: "hel", reasoning: "" };
    const next = { streamed: "hello", reasoning: "" };
    expect(nextFlush(prev, next)).toBe(next);
  });

  it("returns the next state when only the reasoning changed", () => {
    const prev = { streamed: "", reasoning: "step 1" };
    const next = { streamed: "", reasoning: "step 1 step 2" };
    expect(nextFlush(prev, next)).toBe(next);
  });
});

describe("startTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires on the shared tick cadence with a rising tick count", () => {
    const ticks: number[] = [];
    const stop = startTicker((tick) => ticks.push(tick));
    vi.advanceTimersByTime(TICK_MS * 3 + TICK_MS / 2);
    stop();
    expect(ticks).toEqual([1, 2, 3]);
  });

  it("stops firing after the stop function is called", () => {
    const ticks: number[] = [];
    const stop = startTicker((tick) => ticks.push(tick));
    vi.advanceTimersByTime(TICK_MS);
    stop();
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(ticks).toEqual([1]);
  });
});
