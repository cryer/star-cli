import { type ChildProcess, spawn } from "node:child_process";
import type { HookConfig } from "../config/schema";

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

interface CommandOutcome {
  code: number;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_LIMIT ? `${trimmed.slice(0, STDERR_LIMIT)}…` : trimmed;
}

// On timeout the whole process tree must die: killing only the shell (what
// child_process timeout does) orphans the real command on Windows, where
// cmd.exe does not exec its child — the survivor would keep running and lock
// the working directory.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on(
      "error",
      () => {},
    );
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function runCommand(
  hook: HookConfig,
  event: HookEvent,
  ctx: HookRunContext,
): Promise<CommandOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STAR_HOOK_EVENT: event,
    STAR_CWD: ctx.cwd,
    STAR_SESSION_ID: ctx.sessionId ?? "",
  };
  if (ctx.toolName !== undefined) env.STAR_TOOL_NAME = ctx.toolName;
  if (ctx.toolInput !== undefined) env.STAR_TOOL_INPUT = JSON.stringify(ctx.toolInput);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hook.command, [], {
        shell: true,
        cwd: ctx.cwd,
        env,
        windowsHide: true,
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
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, hook.timeoutSec * 1000);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += chunk.toString("utf8");
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

export async function runHooks(
  event: HookEvent,
  hooks: HookConfig[],
  ctx: HookRunContext,
): Promise<HookRunResult> {
  const result: HookRunResult = { blocked: false, warnings: [] };
  for (const hook of hooks) {
    if (!hookMatches(hook, event, ctx.toolName)) continue;
    let outcome: CommandOutcome;
    try {
      outcome = await runCommand(hook, event, ctx);
    } catch (error) {
      result.warnings.push(
        `Hook "${hook.command}" (${event}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (outcome.code === 0) continue;
    const stderr = truncate(outcome.stderr);
    if (event === "PreToolUse" && outcome.code === 2 && !outcome.timedOut) {
      result.blocked = true;
      result.reason = stderr || `hook "${hook.command}" exited with code 2`;
      return result;
    }
    const detail = outcome.timedOut
      ? `timed out after ${hook.timeoutSec}s`
      : outcome.spawnError
        ? `failed to start: ${outcome.spawnError}`
        : `exited with code ${outcome.code}`;
    result.warnings.push(
      `Hook "${hook.command}" (${event}) ${detail}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result;
}
