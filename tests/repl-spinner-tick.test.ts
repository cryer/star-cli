import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBackend } from "../src/cli/backend";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import type { ChatInput } from "../src/core/messages";
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
    gitSnapshots: true,
    webFetchAllowPrivateHosts: false,
  };
}

// Streams nothing and hangs until the abort signal fires: the turn stays in
// the "waiting on the model" state for as long as the test wants.
function hangingBackend(): ChatBackend {
  return {
    async *stream(_input: ChatInput, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

describe("REPL spinner ticking", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-spinner-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-spinner-home-"));
    vi.stubEnv("STAR_HOME", home);
    // Pin the icon set: the thinking label icon depends on terminal detection.
    vi.stubEnv("STAR_ICONS", "plain");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of [cwd, home]) await rmWithRetry(dir);
  });

  it(
    "keeps animating the spinner while an idle turn waits, with no stream events",
    { timeout: 30_000 },
    async () => {
      const app = renderApp(
        createElement(Repl, {
          backend: hangingBackend(),
          model: "test",
          permissionMode: "auto",
          config: makeConfig(),
          cwd,
          sessionStore: null,
        }),
      );
      await tick();
      await typeText(app.stdin, "hello", "\r");
      // The thinking indicator comes up on its own 100ms ticker; the stream
      // produces nothing, so any frame change is the spinner animating.
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("star is thinking");
        },
        { timeout: 15_000 },
      );
      const frames = new Set<string>();
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        frames.add(stripAnsi(app.lastFrame() ?? ""));
      }
      // Distinct frames over ~700ms with zero stream activity = the spinner
      // advanced on its own (several braille frames cycled).
      expect(frames.size).toBeGreaterThan(1);
      app.unmount();
    },
  );
});
