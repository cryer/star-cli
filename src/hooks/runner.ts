import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { HookConfig } from "../config/schema";
import { killTree } from "../core/process";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookRunContext {
  cwd: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface HookRunResult {
  blocked: boolean;
  reason?: string;
  warnings: string[];
}

const STDERR_LIMIT = 2000;
const STDERR_CAPTURE_LIMIT = 64 * 1024;
// Tool input rides in the environment as STAR_TOOL_INPUT, but env blocks are
// capped (Linux E2BIG, 32KB on Windows), so past this many UTF-8 bytes the
// JSON is piped to the hook's stdin instead, marked by STAR_TOOL_INPUT_STDIN=1.
const STDIN_PAYLOAD_THRESHOLD = 16 * 1024;

interface CommandOutcome {
  code: number;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
  spawnError?: string;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_LIMIT ? `${trimmed.slice(0, STDERR_LIMIT)}…` : trimmed;
}

function runCommand(
  hook: HookConfig,
  event: HookEvent,
  ctx: HookRunContext,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STAR_HOOK_EVENT: event,
    STAR_CWD: ctx.cwd,
    STAR_SESSION_ID: ctx.sessionId ?? "",
  };
  if (ctx.toolName !== undefined) env.STAR_TOOL_NAME = ctx.toolName;
  const inputJson = ctx.toolInput !== undefined ? JSON.stringify(ctx.toolInput) : undefined;
  const inputViaStdin =
    inputJson !== undefined && Buffer.byteLength(inputJson, "utf8") > STDIN_PAYLOAD_THRESHOLD;
  if (inputJson !== undefined && !inputViaStdin) env.STAR_TOOL_INPUT = inputJson;
  if (inputViaStdin) env.STAR_TOOL_INPUT_STDIN = "1";
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: 1, stderr: "", timedOut: false, aborted: true });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(hook.command, [], {
        shell: true,
        cwd: ctx.cwd,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        code: 1,
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // A hook that exits before reading its input closes the pipe early; the
    // resulting EPIPE is just a failing hook, reported via its exit code.
    if (inputViaStdin && inputJson !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(inputJson);
    } else {
      child.stdin?.on("error", () => {});
      child.stdin?.end();
    }
    let stderr = "";
    // Chunk-wise toString would corrupt multi-byte UTF-8 split across chunks.
    const stderrDecoder = new StringDecoder("utf8");
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, stderr: outcome.stderr + stderrDecoder.end() });
    };
    const terminate = (outcome: CommandOutcome) => {
      termination ??= (async () => {
        await killTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      })();
      void termination.then(
        () => finish(outcome),
        () => finish(outcome),
      );
    };
    const onAbort = () => terminate({ code: 1, stderr, timedOut: false, aborted: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate({ code: 1, stderr, timedOut: true });
    }, timeoutSec * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += stderrDecoder.write(chunk);
    });
    child.stdout?.resume();
    child.on("error", (error) => {
      finish({ code: 1, stderr, timedOut, spawnError: error.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stderr, timedOut });
    });
  });
}

function hookMatches(hook: HookConfig, event: HookEvent, toolName?: string): boolean {
  if (hook.event !== event) return false;
  // A matcher filters by tool name; Stop carries no tool, so matchers are
  // ignored there. Invalid patterns are rejected at config load, but guard
  // anyway so a hook can never crash the agent.
  if (event === "Stop" || !hook.matcher) return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    return false;
  }
}

export interface RunHooksOptions {
  // Per-invocation timeout override (seconds), replacing each hook's own
  // timeoutSec — e.g. the abort path keeps Stop hooks on a short leash so a
  // hanging hook cannot hold the user's prompt hostage.
  timeoutSec?: number;
  signal?: AbortSignal;
}

export async function runHooks(
  event: HookEvent,
  hooks: HookConfig[],
  ctx: HookRunContext,
  opts?: RunHooksOptions,
): Promise<HookRunResult> {
  const result: HookRunResult = { blocked: false, warnings: [] };
  for (const hook of hooks) {
    if (opts?.signal?.aborted) return result;
    if (!hookMatches(hook, event, ctx.toolName)) continue;
    const timeoutSec = opts?.timeoutSec ?? hook.timeoutSec;
    let outcome: CommandOutcome;
    try {
      outcome = await runCommand(hook, event, ctx, timeoutSec, opts?.signal);
    } catch (error) {
      if (opts?.signal?.aborted) return result;
      result.warnings.push(
        `Hook "${hook.command}" (${event}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (outcome.aborted || opts?.signal?.aborted) return result;
    if (outcome.code === 0) continue;
    const stderr = truncate(outcome.stderr);
    if (event === "PreToolUse" && outcome.code === 2 && !outcome.timedOut) {
      result.blocked = true;
      result.reason = stderr || `hook "${hook.command}" exited with code 2`;
      return result;
    }
    const detail = outcome.timedOut
      ? `timed out after ${timeoutSec}s`
      : outcome.spawnError
        ? `failed to start: ${outcome.spawnError}`
        : `exited with code ${outcome.code}`;
    result.warnings.push(
      `Hook "${hook.command}" (${event}) ${detail}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result;
}
