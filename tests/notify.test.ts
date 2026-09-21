import { describe, expect, it } from "vitest";
import { BELL, type NotifyBellInput, notifyBell, shouldNotifyBell } from "../src/cli/notify";

function input(overrides: Partial<NotifyBellInput> = {}): NotifyBellInput {
  return {
    enabled: true,
    thresholdSec: 10,
    noNotifyEnv: false,
    ...overrides,
  };
}

describe("shouldNotifyBell", () => {
  it("rings when a turn took longer than the threshold", () => {
    expect(shouldNotifyBell(input({ elapsedMs: 10_000 }), true)).toBe(true);
    expect(shouldNotifyBell(input({ elapsedMs: 15_000 }), true)).toBe(true);
  });

  it("stays silent below the threshold", () => {
    expect(shouldNotifyBell(input({ elapsedMs: 9_999 }), true)).toBe(false);
    expect(shouldNotifyBell(input({ elapsedMs: 0 }), true)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(shouldNotifyBell(input({ thresholdSec: 60, elapsedMs: 30_000 }), true)).toBe(false);
    expect(shouldNotifyBell(input({ thresholdSec: 60, elapsedMs: 61_000 }), true)).toBe(true);
  });

  it("stays silent for interrupted turns", () => {
    expect(shouldNotifyBell(input({ interrupted: true, elapsedMs: 60_000 }), true)).toBe(false);
  });

  it("stays silent when disabled via config", () => {
    expect(shouldNotifyBell(input({ enabled: false, elapsedMs: 60_000 }), true)).toBe(false);
  });

  it("stays silent when STAR_NO_NOTIFY is set", () => {
    expect(shouldNotifyBell(input({ noNotifyEnv: true, elapsedMs: 60_000 }), true)).toBe(false);
  });

  it("stays silent when stdout is not a TTY", () => {
    expect(shouldNotifyBell(input({ elapsedMs: 60_000 }), false)).toBe(false);
  });

  it("rings for events without a duration (background task completion)", () => {
    expect(shouldNotifyBell(input(), true)).toBe(true);
    expect(shouldNotifyBell(input({ interrupted: true }), true)).toBe(false);
  });
});

describe("notifyBell", () => {
  it("writes exactly one BEL when the conditions pass", () => {
    const writes: string[] = [];
    const rang = notifyBell(input({ elapsedMs: 20_000 }), {
      write: (text) => writes.push(text),
      isTTY: true,
    });
    expect(rang).toBe(true);
    expect(writes).toEqual([BELL]);
    expect(BELL).toBe("\x07");
  });

  it("writes nothing when the conditions fail", () => {
    const writes: string[] = [];
    const rang = notifyBell(input({ elapsedMs: 100 }), {
      write: (text) => writes.push(text),
      isTTY: true,
    });
    expect(rang).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes nothing on a non-TTY even when everything else passes", () => {
    const writes: string[] = [];
    const rang = notifyBell(input({ elapsedMs: 20_000 }), {
      write: (text) => writes.push(text),
      isTTY: false,
    });
    expect(rang).toBe(false);
    expect(writes).toEqual([]);
  });
});
