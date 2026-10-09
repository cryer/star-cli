import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import { createDefaultRegistry } from "../src/tools";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";
import { rmWithRetry } from "./test-fs";

process.env.STAR_NO_UPDATE_CHECK = "1";
const { Repl } = await import("../src/cli/repl");

function makeConfig(): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    streamFirstChunkTimeoutSec: 300,
    streamMaxRetries: 3,
    maxAutoContinues: 2,
    notifyBell: false,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: false,
    webFetchAllowPrivateHosts: false,
  };
}

function mockModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-delta", textDelta: "ok" },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

describe("StatusBar context percent", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-ctx-"));
  });

  afterEach(async () => {
    await rmWithRetry(cwd);
  });

  it(
    "reflects conversation size after a turn with a large prompt",
    { timeout: 30_000 },
    async () => {
      const config = makeConfig();
      const backend = new AgentLoop({
        model: mockModel(),
        registry: createDefaultRegistry(),
        config,
        cwd,
      });
      const app = renderApp(
        createElement(Repl, {
          backend,
          model: "test",
          permissionMode: "auto",
          config,
          cwd,
          sessionStore: null,
        }),
      );
      await tick();
      // 20k chars ≈ 5k estimated tokens ≈ 5% of a 100k window.
      await typeText(app.stdin, "x".repeat(20_000), "\r");
      await vi.waitFor(
        () => {
          const frame = stripAnsi(app.lastFrame() ?? "");
          expect(frame).toContain("ok");
        },
        { timeout: 15_000 },
      );
      for (let i = 0; i < 5; i++) await tick();
      const frame = stripAnsi(app.lastFrame() ?? "");
      const match = frame.match(/ctx: ([\d.]+)%/);
      expect(match, `frame should show ctx %, got: ${frame.slice(-300)}`).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThanOrEqual(4);
      app.unmount();
    },
  );

  it("shows a decimal instead of 0% for small real usage", { timeout: 30_000 }, async () => {
    const config = makeConfig();
    const backend = new AgentLoop({
      model: mockModel(),
      registry: createDefaultRegistry(),
      config,
      cwd,
    });
    const app = renderApp(
      createElement(Repl, {
        backend,
        model: "test",
        permissionMode: "auto",
        config,
        cwd,
        sessionStore: null,
      }),
    );
    await tick();
    // 1500 chars ≈ 375 estimated tokens; the tool-schema overhead (~2k
    // tokens) is now included in ctx %, so small real usage lands in the
    // low single digits of a 100k window — still the one-decimal path.
    await typeText(app.stdin, "x".repeat(1500), "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("ok");
      },
      { timeout: 15_000 },
    );
    for (let i = 0; i < 5; i++) await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    const match = frame.match(/ctx: ([\d.]+)%/);
    expect(match, `frame should show ctx %, got: ${frame.slice(-300)}`).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
    expect(Number(match?.[1])).toBeLessThan(10);
    expect(match?.[1]).toContain(".");
    app.unmount();
  });

  it("refreshes ctx % immediately after a /model switch", { timeout: 30_000 }, async () => {
    const config = makeConfig();
    config.providers.push({
      name: "p",
      protocol: "anthropic",
      baseURL: "https://example.invalid",
      apiKey: "test-key",
    });
    config.models.push(
      { name: "test", provider: "p", model: "m1", contextMaxTokens: 100_000 },
      { name: "big", provider: "p", model: "m2", contextMaxTokens: 1_000_000 },
    );
    const backend = new AgentLoop({
      model: mockModel(),
      registry: createDefaultRegistry(),
      config,
      cwd,
    });
    const app = renderApp(
      createElement(Repl, {
        backend,
        model: "test",
        permissionMode: "auto",
        config,
        cwd,
        sessionStore: null,
      }),
    );
    await tick();
    // 20k chars ≈ 5k estimated tokens: 5% of the 100k window, 0.5% of 1M.
    await typeText(app.stdin, "x".repeat(20_000), "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("ok");
      },
      { timeout: 15_000 },
    );
    for (let i = 0; i < 5; i++) await tick();
    const before = stripAnsi(app.lastFrame() ?? "").match(/ctx: ([\d.]+)%/);
    expect(Number(before?.[1])).toBeGreaterThanOrEqual(4);
    await typeText(app.stdin, "/model big", "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain('Switched to model "big"');
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      () => {
        const after = stripAnsi(app.lastFrame() ?? "").match(/ctx: ([\d.]+)%/);
        expect(after, "ctx % should recompute against the new window").not.toBeNull();
        expect(Number(after?.[1])).toBeLessThan(1);
      },
      { timeout: 15_000 },
    );
    app.unmount();
  });

  it(
    "refreshes ctx % mid-turn while a long turn is still streaming",
    { timeout: 30_000 },
    async () => {
      const config = makeConfig();
      // 40k chars ≈ 10k estimated tokens ≈ 10%+ of the 100k window once the
      // read_file result lands in the history mid-turn.
      const bigPath = path.join(cwd, "big.txt");
      writeFileSync(bigPath, "y".repeat(40_000));
      let call = 0;
      const model = new MockLanguageModelV1({
        doStream: async () => {
          call += 1;
          if (call === 1) {
            return {
              stream: convertArrayToReadableStream([
                {
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "c1",
                  toolName: "read_file",
                  args: JSON.stringify({ path: bigPath }),
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { promptTokens: 5, completionTokens: 3 },
                },
              ]),
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          // The follow-up reply stays silent for seconds: without the
          // mid-turn refresh the ctx % would sit at the turn-start value
          // until this finishes and the turn boundary re-triggers the
          // effect. The delay must clear the mid-turn waitFor window below
          // with margin — loaded CI runners (windows + Node 20) burn several
          // seconds before the first 2s interval tick lands.
          const stream = new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue({ type: "text-delta", textDelta: "done" });
                controller.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { promptTokens: 5, completionTokens: 3 },
                });
                controller.close();
              }, 14000);
            },
          });
          return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
        },
      });
      const backend = new AgentLoop({
        model: model as never,
        registry: createDefaultRegistry(),
        config,
        cwd,
      });
      const app = renderApp(
        createElement(Repl, {
          backend,
          model: "test",
          permissionMode: "auto",
          config,
          cwd,
          sessionStore: null,
        }),
      );
      await tick();
      await typeText(app.stdin, "hi", "\r");
      // The 2s streaming interval must pick up the read_file bulk long before
      // the turn ends (the delayed reply lands ~14s in).
      await vi.waitFor(
        () => {
          const frame = stripAnsi(app.lastFrame() ?? "");
          expect(frame).not.toContain("done");
          const match = frame.match(/ctx: ([\d.]+)%/);
          expect(match, `frame should show ctx %, got: ${frame.slice(-300)}`).not.toBeNull();
          expect(Number(match?.[1])).toBeGreaterThanOrEqual(8);
        },
        { timeout: 11000 },
      );
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("done");
        },
        { timeout: 20_000 },
      );
      app.unmount();
    },
  );
});
