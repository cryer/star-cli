import { describe, expect, it } from "vitest";
import { BUDGET_WARN_RATIO, budgetState } from "../src/cli/budget";

describe("budgetState", () => {
  it("is ok below the warn threshold", () => {
    expect(budgetState(0, 10)).toBe("ok");
    expect(budgetState(10 * BUDGET_WARN_RATIO - 0.001, 10)).toBe("ok");
  });

  it("warns at and above 80% of the budget", () => {
    expect(budgetState(8, 10)).toBe("warn");
    expect(budgetState(9.99, 10)).toBe("warn");
  });

  it("is exceeded at and above 100% of the budget", () => {
    expect(budgetState(10, 10)).toBe("exceeded");
    expect(budgetState(12, 10)).toBe("exceeded");
  });

  it("is ok when no budget is configured", () => {
    expect(budgetState(1000, undefined)).toBe("ok");
  });

  it("is ok when the cost is unknown (no model pricing)", () => {
    expect(budgetState(null, 10)).toBe("ok");
  });
});
