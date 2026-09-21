import { describe, expect, it } from "vitest";
import { DOUBLE_ESC_WINDOW_MS, isDoubleEscape } from "../src/cli/double-esc";

describe("isDoubleEscape", () => {
  it("is false without a previous press", () => {
    expect(isDoubleEscape(null, 1000)).toBe(false);
  });

  it("is true for a second press within the window", () => {
    expect(isDoubleEscape(1000, 1000 + DOUBLE_ESC_WINDOW_MS)).toBe(true);
    expect(isDoubleEscape(1000, 1001)).toBe(true);
  });

  it("is false for a second press after the window", () => {
    expect(isDoubleEscape(1000, 1000 + DOUBLE_ESC_WINDOW_MS + 1)).toBe(false);
  });

  it("honors a custom window", () => {
    expect(isDoubleEscape(0, 50, 100)).toBe(true);
    expect(isDoubleEscape(0, 150, 100)).toBe(false);
  });
});
