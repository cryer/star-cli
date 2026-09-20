import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/cli/cost";
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
});
