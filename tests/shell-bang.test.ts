import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import {
  buildShellContextMessage,
  executeShellBang,
  truncateShellOutput,
} from "../src/cli/shell-bang";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { isDangerousCommand } from "../src/permissions/gate";
import { createDefaultRegistry } from "../src/tools";

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
    notifyBell: true,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [] },
    hooks: [],
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("isDangerousCommand", () => {
  it("flags destructive patterns", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("rm -rf ~/projects")).toBe(true);
    expect(isDangerousCommand("shutdown now")).toBe(true);
  });

  it("allows ordinary commands", () => {
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("rm -rf node_modules")).toBe(false);
  });
});

describe("executeShellBang", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-bang-test-"));
  });

  afterEach(async () => {
    // aborted Git Bash process trees can linger on Windows runners; best-effort cleanup
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(cwd, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  it("runs a real command and merges output", async () => {
    const outcome = await executeShellBang("echo hello-bang", cwd);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.command).toBe("echo hello-bang");
      expect(outcome.output).toContain("hello-bang");
      expect(outcome.isError).toBe(false);
      expect(outcome.contextMessage).toContain("hello-bang");
    }
  });

  it("reports non-zero exit codes as errors", async () => {
    const outcome = await executeShellBang("exit 3", cwd);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.isError).toBe(true);
      expect(outcome.output).toContain("Exit code: 3");
    }
  });

  it("refuses dangerous commands without executing them", async () => {
    const outcome = await executeShellBang("rm -rf /", cwd);
    expect(outcome).toEqual({ ok: false, reason: "dangerous" });
  });

  it("rejects empty input", async () => {
    const outcome = await executeShellBang("   ", cwd);
    expect(outcome).toEqual({ ok: false, reason: "empty" });
  });

  it("aborts a running command via the signal", async () => {
    const controller = new AbortController();
    const pending = executeShellBang("sleep 30", cwd, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.isError).toBe(true);
      expect(outcome.output).toContain("aborted");
    }
  }, 15000);
});

describe("truncateShellOutput", () => {
  it("keeps short output untouched", () => {
    expect(truncateShellOutput("short")).toBe("short");
  });

  it("truncates long output around the middle", () => {
    const long = "x".repeat(10000);
    const truncated = truncateShellOutput(long);
    expect(truncated.length).toBeLessThan(4000);
    expect(truncated).toContain("characters truncated");
  });
});

describe("shell output context injection", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-bang-ctx-"));
  });

  afterEach(async () => {
    // aborted Git Bash process trees can linger on Windows runners; best-effort cleanup
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(cwd, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  it("makes prior shell output visible in the next model request", async () => {
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (opts) => {
        capturedPrompt = opts.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "seen" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });

    const outcome = await executeShellBang("echo injected-marker-123", cwd);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      await loop.appendContextMessage(outcome.contextMessage);
    }

    await collect(loop.stream("what did I run?", new AbortController().signal));

    expect(JSON.stringify(capturedPrompt)).toContain("injected-marker-123");
    expect(JSON.stringify(capturedPrompt)).toContain("echo injected-marker-123");
  });

  it("builds a context message containing command and output", () => {
    const message = buildShellContextMessage("git status", "clean");
    expect(message).toContain("!git status");
    expect(message).toContain("clean");
  });
});
