import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import { createDefaultRegistry } from "../src/tools";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

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
    notifyBell: false,
    notifyBellThresholdSec: 10,
    permissions: { allow: [] },
    hooks: [],
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

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reflects conversation size after a turn with a large prompt", async () => {
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
      { timeout: 5000 },
    );
    for (let i = 0; i < 5; i++) await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    const match = frame.match(/ctx: ([\d.]+)%/);
    expect(match, `frame should show ctx %, got: ${frame.slice(-300)}`).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(4);
    app.unmount();
  });

  it("shows a decimal instead of 0% for small real usage", async () => {
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
    // 1500 chars ≈ 375 estimated tokens ≈ 0.4% of a 100k window.
    await typeText(app.stdin, "x".repeat(1500), "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("ok");
      },
      { timeout: 5000 },
    );
    for (let i = 0; i < 5; i++) await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    const match = frame.match(/ctx: ([\d.]+)%/);
    expect(match, `frame should show ctx %, got: ${frame.slice(-300)}`).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(0);
    expect(Number(match?.[1])).toBeLessThan(1);
    app.unmount();
  });
});
