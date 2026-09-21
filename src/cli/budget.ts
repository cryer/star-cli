export type BudgetStatus = "ok" | "warn" | "exceeded";

export const BUDGET_WARN_RATIO = 0.8;

// Session budget decision against config.sessionBudgetUsd. Cost is null when
// the model has no pricing configured — the budget cannot be evaluated then.
export function budgetState(costUsd: number | null, budgetUsd: number | undefined): BudgetStatus {
  if (budgetUsd === undefined || costUsd === null) return "ok";
  if (costUsd >= budgetUsd) return "exceeded";
  if (costUsd >= budgetUsd * BUDGET_WARN_RATIO) return "warn";
  return "ok";
}
