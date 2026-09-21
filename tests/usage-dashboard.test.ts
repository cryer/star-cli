import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import { sessionsDir } from "../src/config/paths";
import type { ModelConfig } from "../src/config/schema";
import { type SessionMeta, SessionStore } from "../src/session/store";
import { aggregateUsage, collectUsageStats, formatUsageDashboard } from "../src/session/usage";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-usage-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function makeMeta(partial: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    title: "",
    model: "gpt-4o",
    cwd: "/work",
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

const PRICED: ModelConfig[] = [
  { name: "gpt-4o", provider: "openai", model: "gpt-4o", promptPrice: 2, completionPrice: 8 },
];

function sampleMetas(): SessionMeta[] {
  return [
    makeMeta({
      id: "a",
      model: "gpt-4o",
      usage: { requests: 2, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      usageByDay: {
        "2025-01-01": { promptTokens: 600, completionTokens: 300, totalTokens: 900 },
        "2025-01-02": { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
      },
    }),
    makeMeta({
      id: "b",
      model: "claude",
      usage: { requests: 1, promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    }),
    makeMeta({
      id: "c",
      model: "",
      usage: { requests: 1, promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      usageByDay: {
        "2025-01-02": { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      },
    }),
    makeMeta({ id: "d", model: "gpt-4o" }),
  ];
}

describe("SessionStore.addUsage", () => {
  it("accumulates totals and per-day buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 5, 10));
    const store = await SessionStore.create("/work", "gpt-4o");
    await store.addUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    vi.setSystemTime(new Date(2025, 0, 6, 23));
    await store.addUsage({ promptTokens: 200, completionTokens: 20, totalTokens: 220 });

    const meta = await store.meta();
    expect(meta.usage).toEqual({
      requests: 2,
      promptTokens: 300,
      completionTokens: 70,
      totalTokens: 370,
    });
    expect(meta.usageByDay).toEqual({
      "2025-01-05": { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      "2025-01-06": { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
    });
  });
});

describe("aggregateUsage", () => {
  it("aggregates totals, days, legacy and models across sessions", () => {
    const stats = aggregateUsage(sampleMetas());

    expect(stats.sessions).toBe(4);
    expect(stats.sessionsWithUsage).toBe(3);
    expect(stats.requests).toBe(4);
    expect(stats.promptTokens).toBe(1250);
    expect(stats.completionTokens).toBe(625);
    expect(stats.totalTokens).toBe(1875);

    expect(stats.days).toEqual([
      { date: "2025-01-01", promptTokens: 600, completionTokens: 300, totalTokens: 900 },
      { date: "2025-01-02", promptTokens: 450, completionTokens: 225, totalTokens: 675 },
    ]);

    expect(stats.legacy).toEqual({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });

    expect(stats.models.map((m) => m.model)).toEqual(["gpt-4o", "claude", "unknown"]);
    expect(stats.models[0]).toMatchObject({ sessions: 1, requests: 2, totalTokens: 1500 });
    expect(stats.models[2]).toMatchObject({ model: "unknown", sessions: 1, totalTokens: 75 });
  });

  it("treats usage beyond the per-day buckets as legacy", () => {
    const stats = aggregateUsage([
      makeMeta({
        id: "a",
        usage: { requests: 3, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        usageByDay: {
          "2025-01-01": { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
        },
      }),
    ]);
    expect(stats.legacy).toEqual({ promptTokens: 600, completionTokens: 300, totalTokens: 900 });
  });

  it("tolerates corrupt or missing fields", () => {
    const stats = aggregateUsage([
      makeMeta({
        id: "bad-numbers",
        usage: {
          requests: Number.NaN,
          promptTokens: -5,
          completionTokens: Number.NaN,
          totalTokens: 100,
        },
        usageByDay: {
          "not-a-date": { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        },
      }),
      makeMeta({
        id: "only-days",
        model: "claude",
        usageByDay: {
          "2025-01-03": { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        },
      }),
      makeMeta({ id: "nothing" }),
    ]);

    expect(stats.sessions).toBe(3);
    expect(stats.sessionsWithUsage).toBe(2);
    expect(stats.requests).toBe(0);
    expect(stats.promptTokens).toBe(7);
    expect(stats.completionTokens).toBe(3);
    expect(stats.totalTokens).toBe(110);
    expect(stats.days).toEqual([
      { date: "2025-01-03", promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    ]);
    expect(stats.legacy).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 100 });
  });

  it("clamps legacy at zero when day buckets exceed the totals", () => {
    const stats = aggregateUsage([
      makeMeta({
        id: "a",
        usage: { requests: 1, promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        usageByDay: {
          "2025-01-01": { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
        },
      }),
    ]);
    expect(stats.legacy).toBeNull();
    expect(stats.days).toEqual([
      { date: "2025-01-01", promptTokens: 50, completionTokens: 50, totalTokens: 100 },
    ]);
  });
});

describe("collectUsageStats", () => {
  it("reads every session under STAR_HOME and skips corrupt metas", async () => {
    const first = await SessionStore.create("/a", "gpt-4o");
    await first.append({ role: "user", content: "hi" });
    await first.addUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const second = await SessionStore.create("/b", "claude");
    await second.append({ role: "user", content: "hi" });
    await second.addUsage({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    fs.mkdirSync(path.join(sessionsDir(), "broken"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), "broken", "meta.json"), "{not json");

    const stats = await collectUsageStats();
    expect(stats.sessions).toBe(2);
    expect(stats.sessionsWithUsage).toBe(2);
    expect(stats.totalTokens).toBe(45);
    expect(stats.models.map((m) => m.model).sort()).toEqual(["claude", "gpt-4o"]);
  });
});

describe("formatUsageDashboard", () => {
  it("renders totals, per-day bars, legacy line and per-model table", () => {
    const text = formatUsageDashboard(aggregateUsage(sampleMetas()), PRICED);

    expect(text).toContain("Token usage across all sessions");
    expect(text).toContain("Total: 4 sessions (3 with usage)");
    expect(text).toContain("1,250 prompt + 625 completion = 1,875 tokens");
    expect(text).toContain("By day:");
    expect(text).toContain("2025-01-01");
    expect(text).toContain("2025-01-02");
    expect(text).toContain("█");
    expect(text).toContain("Earlier usage without per-day records: 300 tokens");
    expect(text).toContain("gpt-4o");
    expect(text).toContain("claude");
    expect(text).toContain("unknown");
    // gpt-4o: (1000 * 2 + 500 * 8) / 1M = $0.006
    expect(text).toContain("$0.006");
    expect(text).toContain("—");
    expect(text).toContain(
      "Estimated cost: $0.006 (excludes claude, unknown — no price configured)",
    );
  });

  it("reports unknown cost when no model has pricing", () => {
    const text = formatUsageDashboard(aggregateUsage(sampleMetas()), []);
    expect(text).toContain("Estimated cost: unknown (no per-model pricing configured)");
  });

  it("caps the day list at maxDays", () => {
    const metas: SessionMeta[] = [
      makeMeta({
        id: "a",
        usageByDay: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `2025-01-${String(i + 1).padStart(2, "0")}`,
            { promptTokens: i + 1, completionTokens: 0, totalTokens: i + 1 },
          ]),
        ),
      }),
    ];
    const text = formatUsageDashboard(aggregateUsage(metas), [], { maxDays: 3 });
    expect(text).toContain("By day (last 3 of 20 days with usage):");
    expect(text).not.toContain("2025-01-17");
    expect(text).toContain("2025-01-18");
    expect(text).toContain("2025-01-20");
  });

  it("handles the empty and no-usage cases", () => {
    expect(formatUsageDashboard(aggregateUsage([]), [])).toBe("No sessions found.");
    const text = formatUsageDashboard(aggregateUsage([makeMeta({ id: "a" })]), []);
    expect(text).toContain("Total: 1 sessions (0 with usage)");
    expect(text).toContain("No token usage recorded yet.");
  });
});

describe("/usage command", () => {
  it("shows the global dashboard from the context hook", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const calls: { type: string; text?: string }[] = [];
    const ctx = {
      addSystemMessage: (text: string) => calls.push({ type: "system", text }),
      showGlobalUsage: async () => "global usage dashboard",
    } as unknown as CommandContext;

    await registry.get("usage")?.run("", ctx);

    expect(calls).toEqual([{ type: "system", text: "global usage dashboard" }]);
  });
});
