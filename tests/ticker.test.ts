import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_FLUSH_MS,
  TICK_MS,
  createFlushScheduler,
  isMotionDisabled,
  nextFlush,
  startTicker,
} from "../src/cli/ticker";

describe("isMotionDisabled", () => {
  it("only enables reduced motion for STAR_NO_MOTION=1", () => {
    expect(isMotionDisabled({ STAR_NO_MOTION: "1" })).toBe(true);
    expect(isMotionDisabled({ STAR_NO_MOTION: "0" })).toBe(false);
    expect(isMotionDisabled({})).toBe(false);
  });
});

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

describe("createFlushScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes the first request immediately and coalesces the trailing request", () => {
    const flush = vi.fn();
    const scheduler = createFlushScheduler(flush);
    scheduler.request();
    expect(flush).toHaveBeenCalledTimes(1);
    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(STREAM_FLUSH_MS - 1);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("cancels a pending trailing flush on stop", () => {
    const flush = vi.fn();
    const scheduler = createFlushScheduler(flush);
    scheduler.request();
    scheduler.request();
    scheduler.stop();
    vi.advanceTimersByTime(STREAM_FLUSH_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
