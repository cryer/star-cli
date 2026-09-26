import { computeCostUsd, formatDollars } from "../cli/cost";
import type { ModelConfig } from "../config/schema";
import { type SessionMeta, SessionStore } from "./store";

export interface UsageBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DayUsage extends UsageBucket {
  date: string;
}

export interface ModelUsage extends UsageBucket {
  model: string;
  sessions: number;
  requests: number;
  // Prompt-cache totals for cache-aware pricing; absent until reported.
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
}

export interface GlobalUsageStats {
  sessions: number;
  sessionsWithUsage: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Ascending by date (YYYY-MM-DD, local).
  days: DayUsage[];
  // Tokens recorded before per-day bucketing existed (usage totals minus the
  // sum of usageByDay), null when nothing predates it.
  legacy: UsageBucket | null;
  // Descending by totalTokens.
  models: ModelUsage[];
}

export const USAGE_MAX_DAYS = 14;

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function bucketOf(value: unknown): UsageBucket {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const promptTokens = tokens(record.promptTokens);
  const completionTokens = tokens(record.completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: tokens(record.totalTokens) || promptTokens + completionTokens,
  };
}

function addTo(target: UsageBucket, source: UsageBucket): void {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.totalTokens += source.totalTokens;
}

export function aggregateUsage(metas: SessionMeta[]): GlobalUsageStats {
  const days = new Map<string, UsageBucket>();
  const models = new Map<string, ModelUsage>();
  const legacy: UsageBucket = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let hasLegacy = false;
  let sessionsWithUsage = 0;
  let requests = 0;
  const grand: UsageBucket = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const meta of metas) {
    const dayBuckets: [string, UsageBucket][] = [];
    if (meta.usageByDay !== null && typeof meta.usageByDay === "object") {
      for (const [date, value] of Object.entries(meta.usageByDay)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        dayBuckets.push([date, bucketOf(value)]);
      }
    }
    const daySum: UsageBucket = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const [, bucket] of dayBuckets) addTo(daySum, bucket);

    const hasTotals = meta.usage !== null && typeof meta.usage === "object";
    const totals = hasTotals ? bucketOf(meta.usage) : daySum;
    const requestCount = hasTotals && meta.usage ? tokens(meta.usage.requests) : 0;
    if (!hasTotals && dayBuckets.length === 0) continue;

    sessionsWithUsage += 1;
    addTo(grand, totals);
    requests += requestCount;

    for (const [date, bucket] of dayBuckets) {
      const acc = days.get(date) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      addTo(acc, bucket);
      days.set(date, acc);
    }

    if (hasTotals) {
      const rest: UsageBucket = {
        promptTokens: Math.max(0, totals.promptTokens - daySum.promptTokens),
        completionTokens: Math.max(0, totals.completionTokens - daySum.completionTokens),
        totalTokens: Math.max(0, totals.totalTokens - daySum.totalTokens),
      };
      if (rest.promptTokens > 0 || rest.completionTokens > 0 || rest.totalTokens > 0) {
        addTo(legacy, rest);
        hasLegacy = true;
      }
    }

    const name = typeof meta.model === "string" && meta.model.trim() ? meta.model : "unknown";
    const entry = models.get(name) ?? {
      model: name,
      sessions: 0,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    entry.sessions += 1;
    entry.requests += requestCount;
    addTo(entry, totals);
    if (hasTotals && meta.usage) {
      const cached = tokens(meta.usage.cachedPromptTokens);
      const cacheRead = tokens(meta.usage.cacheReadInputTokens);
      if (cached > 0) entry.cachedPromptTokens = (entry.cachedPromptTokens ?? 0) + cached;
      if (cacheRead > 0) entry.cacheReadInputTokens = (entry.cacheReadInputTokens ?? 0) + cacheRead;
    }
    models.set(name, entry);
  }

  return {
    sessions: metas.length,
    sessionsWithUsage,
    requests,
    promptTokens: grand.promptTokens,
    completionTokens: grand.completionTokens,
    totalTokens: grand.totalTokens,
    days: [...days.entries()]
      .map(([date, bucket]) => ({ date, ...bucket }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    legacy: hasLegacy ? legacy : null,
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

export async function collectUsageStats(): Promise<GlobalUsageStats> {
  return aggregateUsage(await SessionStore.list());
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const BAR_WIDTH = 30;

export function formatUsageDashboard(
  stats: GlobalUsageStats,
  models: ModelConfig[],
  options: { maxDays?: number } = {},
): string {
  if (stats.sessions === 0) return "No sessions found.";

  const lines: string[] = [
    "Token usage across all sessions",
    "",
    `Total: ${stats.sessions} sessions (${stats.sessionsWithUsage} with usage) · ` +
      `${fmt(stats.requests)} requests · ` +
      `${fmt(stats.promptTokens)} prompt + ${fmt(stats.completionTokens)} completion = ` +
      `${fmt(stats.totalTokens)} tokens`,
  ];

  if (stats.sessionsWithUsage === 0) {
    lines.push("", "No token usage recorded yet.");
    return lines.join("\n");
  }

  const maxDays = options.maxDays ?? USAGE_MAX_DAYS;
  const recent = stats.days.slice(-maxDays);
  if (recent.length > 0) {
    lines.push("");
    lines.push(
      stats.days.length > maxDays
        ? `By day (last ${maxDays} of ${stats.days.length} days with usage):`
        : "By day:",
    );
    const maxTotal = Math.max(...recent.map((day) => day.totalTokens));
    for (const day of recent) {
      const barLen =
        maxTotal > 0 ? Math.max(1, Math.round((day.totalTokens / maxTotal) * BAR_WIDTH)) : 0;
      lines.push(`${day.date}  ${fmt(day.totalTokens).padStart(12)}  ${"█".repeat(barLen)}`);
    }
  }
  if (stats.legacy) {
    lines.push(
      `Earlier usage without per-day records: ${fmt(stats.legacy.totalTokens)} tokens ` +
        `(${fmt(stats.legacy.promptTokens)} prompt + ${fmt(stats.legacy.completionTokens)} completion)`,
    );
  }

  lines.push("", "By model:");
  const configured = new Map(models.map((m) => [m.name, m]));
  const rows = stats.models.map((entry) => {
    const cfg = configured.get(entry.model);
    const cost = computeCostUsd(entry, cfg);
    return { entry, cost };
  });
  const header = ["model", "requests", "prompt", "completion", "total", "cost"];
  const cells = rows.map(({ entry, cost }) => [
    entry.model,
    fmt(entry.requests),
    fmt(entry.promptTokens),
    fmt(entry.completionTokens),
    fmt(entry.totalTokens),
    cost === null ? "—" : `$${formatDollars(cost)}`,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  const renderRow = (row: string[]) =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[0] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ");
  lines.push(renderRow(header));
  for (const row of cells) lines.push(renderRow(row));

  const pricedCosts = rows.filter((row) => row.cost !== null).map((row) => row.cost as number);
  const unpriced = rows.filter((row) => row.cost === null).map((row) => row.entry.model);
  if (pricedCosts.length > 0) {
    const total = pricedCosts.reduce((sum, cost) => sum + cost, 0);
    const note =
      unpriced.length > 0 ? ` (excludes ${unpriced.join(", ")} — no price configured)` : "";
    lines.push("", `Estimated cost: $${formatDollars(total)}${note}`);
  } else {
    lines.push("", "Estimated cost: unknown (no per-model pricing configured)");
  }

  return lines.join("\n");
}
