import { describe, expect, it } from "vitest";
import {
  type CacheTotals,
  addToCacheTotals,
  cacheHitPercent,
  cacheUsageReported,
} from "../src/cli/cache-stats";

function totals(): CacheTotals {
  return { cachedTokens: 0, promptTokens: 0 };
}

describe("cacheUsageReported", () => {
  it("is false when no cache fields are present", () => {
    expect(cacheUsageReported({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })).toBe(
      false,
    );
  });

  it("is true for either cache field, including zero", () => {
    expect(
      cacheUsageReported({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedPromptTokens: 0,
      }),
    ).toBe(true);
    expect(
      cacheUsageReported({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadInputTokens: 3,
      }),
    ).toBe(true);
  });
});

describe("addToCacheTotals", () => {
  it("treats OpenAI-style cached tokens as a subset of promptTokens", () => {
    const t = totals();
    addToCacheTotals(t, {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 40,
    });
    expect(t).toEqual({ cachedTokens: 40, promptTokens: 100 });
  });

  it("adds Anthropic-style cache reads to the denominator", () => {
    const t = totals();
    addToCacheTotals(t, {
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
      cacheReadInputTokens: 30,
    });
    expect(t).toEqual({ cachedTokens: 30, promptTokens: 80 });
  });

  it("accumulates across requests and keeps the rate at or below 100%", () => {
    const t = totals();
    addToCacheTotals(t, {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 40,
    });
    addToCacheTotals(t, {
      promptTokens: 60,
      completionTokens: 10,
      totalTokens: 70,
      cacheReadInputTokens: 60,
    });
    expect(t).toEqual({ cachedTokens: 100, promptTokens: 220 });
    expect(cacheHitPercent(t)).toBe(45);
  });
});

describe("cacheHitPercent", () => {
  it("rounds to a whole percent", () => {
    expect(cacheHitPercent({ cachedTokens: 1, promptTokens: 3 })).toBe(33);
  });

  it("clamps out-of-range rates", () => {
    expect(cacheHitPercent({ cachedTokens: 200, promptTokens: 100 })).toBe(100);
  });

  it("returns null when nothing cache-eligible was sent", () => {
    expect(cacheHitPercent({ cachedTokens: 0, promptTokens: 0 })).toBeNull();
  });
});
