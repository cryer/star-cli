import { describe, expect, it } from "vitest";
import { computeCostUsd, estimateCost } from "../src/cli/cost";
import { ModelConfigSchema } from "../src/config/schema";

describe("ModelConfigSchema pricing", () => {
  it("accepts optional promptPrice/completionPrice", () => {
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 0.15,
      completionPrice: 0.6,
    });
    expect(model.promptPrice).toBe(0.15);
    expect(model.completionPrice).toBe(0.6);
  });

  it("keeps prices optional", () => {
    const model = ModelConfigSchema.parse({ name: "gpt6", provider: "p", model: "m" });
    expect(model.promptPrice).toBeUndefined();
    expect(model.completionPrice).toBeUndefined();
  });

  it("accepts an optional cacheReadPrice", () => {
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 0.15,
      completionPrice: 0.6,
      cacheReadPrice: 0.015,
    });
    expect(model.cacheReadPrice).toBe(0.015);
    const without = ModelConfigSchema.parse({ name: "gpt6", provider: "p", model: "m" });
    expect(without.cacheReadPrice).toBeUndefined();
  });
});

describe("computeCostUsd cache pricing", () => {
  const cachePriced = ModelConfigSchema.parse({
    name: "gpt6",
    provider: "p",
    model: "m",
    promptPrice: 1,
    completionPrice: 2,
    cacheReadPrice: 0.1,
  });

  it("bills OpenAI-style cached tokens at cacheReadPrice, the rest at promptPrice", () => {
    // (1000 - 400) uncached * $1/M + 400 cached * $0.1/M + 100 completion * $2/M
    const cost = computeCostUsd(
      { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 400 },
      cachePriced,
    );
    expect(cost).toBeCloseTo((600 * 1 + 400 * 0.1 + 100 * 2) / 1_000_000, 12);
  });

  it("bills OpenAI-style cached tokens at full promptPrice without a cache price", () => {
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 1,
      completionPrice: 2,
    });
    const cost = computeCostUsd(
      { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 400 },
      model,
    );
    expect(cost).toBeCloseTo((1000 * 1 + 100 * 2) / 1_000_000, 12);
  });

  it("bills Anthropic-style cache reads on top of promptTokens at cacheReadPrice", () => {
    // 1000 prompt * $1/M + 300 cache reads * $0.1/M + 100 completion * $2/M
    const cost = computeCostUsd(
      { promptTokens: 1000, completionTokens: 100, cacheReadInputTokens: 300 },
      cachePriced,
    );
    expect(cost).toBeCloseTo((1000 * 1 + 300 * 0.1 + 100 * 2) / 1_000_000, 12);
  });

  it("leaves Anthropic-style cache reads unbilled without a cache price", () => {
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 1,
      completionPrice: 2,
    });
    const cost = computeCostUsd(
      { promptTokens: 1000, completionTokens: 100, cacheReadInputTokens: 300 },
      model,
    );
    expect(cost).toBeCloseTo((1000 * 1 + 100 * 2) / 1_000_000, 12);
  });

  it("never bills negative prompt tokens when cached exceeds prompt", () => {
    const cost = computeCostUsd(
      { promptTokens: 100, completionTokens: 0, cachedPromptTokens: 500 },
      cachePriced,
    );
    expect(cost).toBeCloseTo((100 * 0.1) / 1_000_000, 12);
  });

  it("shows the cache read price in the estimate when configured", () => {
    const text = estimateCost(
      { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 400 },
      "gpt6",
      cachePriced,
    );
    expect(text).toBe(
      "Estimated cost: $0.0008 (gpt6 @ $1/M prompt, $2/M completion, $0.1/M cache read)",
    );
  });
});

describe("estimateCost", () => {
  const priced = ModelConfigSchema.parse({
    name: "gpt6",
    provider: "p",
    model: "m",
    promptPrice: 0.15,
    completionPrice: 0.6,
  });

  it("converts token usage to dollars using the model's prices", () => {
    // 10k prompt * $0.15/M = $0.0015, 10k completion * $0.60/M = $0.006 -> $0.0075
    const text = estimateCost({ promptTokens: 10_000, completionTokens: 10_000 }, "gpt6", priced);
    expect(text).toBe("Estimated cost: $0.0075 (gpt6 @ $0.15/M prompt, $0.6/M completion)");
  });

  it("formats sub-cent amounts with four decimals", () => {
    // 20k prompt * $0.15/M = $0.003 + 2k completion * $0.10/M = $0.0002 -> $0.0032
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 0.15,
      completionPrice: 0.1,
    });
    const text = estimateCost({ promptTokens: 20_000, completionTokens: 2_000 }, "gpt6", model);
    expect(text).toContain("$0.0032");
  });

  it("shows $0.00 for zero usage", () => {
    const text = estimateCost({ promptTokens: 0, completionTokens: 0 }, "gpt6", priced);
    expect(text).toContain("Estimated cost: $0.00");
  });

  it("reports unknown when the model has no prices", () => {
    const unpriced = ModelConfigSchema.parse({ name: "gpt6", provider: "p", model: "m" });
    const text = estimateCost({ promptTokens: 100, completionTokens: 50 }, "gpt6", unpriced);
    expect(text).toBe("Estimated cost: unknown (no price configured for gpt6)");
  });

  it("reports unknown when the model is not in the config", () => {
    const text = estimateCost({ promptTokens: 100, completionTokens: 50 }, "ghost", undefined);
    expect(text).toBe("Estimated cost: unknown (no price configured for ghost)");
  });

  it("names the missing price when only one is set", () => {
    const partial = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      promptPrice: 5,
    });
    const text = estimateCost({ promptTokens: 100, completionTokens: 50 }, "gpt6", partial);
    expect(text).toBe(
      "Estimated cost: unknown (gpt6 is missing completionPrice — both prices are needed)",
    );
  });

  it("accepts a per-model contextMaxTokens override", () => {
    const model = ModelConfigSchema.parse({
      name: "gpt6",
      provider: "p",
      model: "m",
      contextMaxTokens: 272_000,
    });
    expect(model.contextMaxTokens).toBe(272_000);
  });
});
