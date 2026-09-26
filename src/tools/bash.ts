import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defaultTaskManager } from "../tasks/manager";
import type { Tool, ToolResult } from "./types";

export const MAX_OUTPUT = 30000;
const HALF_OUTPUT = MAX_OUTPUT / 2;
const DEFAULT_TIMEOUT = 120;
const MAX_TIMEOUT = 600;

export interface ShellSpec {
  shell: string;
  wrap: (command: string) => string[];
  label: string;
}

function findOnPath(exe: string, exclude?: (dir: string) => boolean): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || exclude?.(dir)) {
      continue;
    }
    const full = path.join(dir, exe);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

function resolveShellUncached(): ShellSpec {
  if (process.platform !== "win32") {
    return { shell: "sh", wrap: (c) => ["-c", c], label: "sh" };
  }
  const isWslStub = (dir: string) => /\\(system32|windowsapps)\\?$/i.test(dir.trim());
  const fromPath = findOnPath("bash.exe", isWslStub);
  if (fromPath) {
    return { shell: fromPath, wrap: (c) => ["-c", c], label: "bash" };
  }
  const gitExe = findOnPath("git.exe");
  if (gitExe) {
    const sibling = path.join(path.dirname(path.dirname(gitExe)), "bin", "bash.exe");
    if (existsSync(sibling)) {
      return { shell: sibling, wrap: (c) => ["-c", c], label: "bash" };
    }
  }
  for (const candidate of [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "D:\\Git\\bin\\bash.exe",
  ]) {
    if (existsSync(candidate)) {
      return { shell: candidate, wrap: (c) => ["-c", c], label: "bash" };
    }
  }
  const comspec = process.env.ComSpec ?? "cmd.exe";
  return { shell: comspec, wrap: (c) => ["/d", "/s", "/c", c], label: "cmd" };
}

// The PATH scan runs once per process; the shell cannot change mid-session.
let cachedSpec: ShellSpec | null = null;

export function resolveShell(): ShellSpec {
  if (!cachedSpec) {
    cachedSpec = resolveShellUncached();
  }
  return cachedSpec;
}

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z
    .number()
    .positive()
    .max(MAX_TIMEOUT)
    .optional()
    .describe("Timeout in seconds (default 120, max 600)"),
  description: z.string().optional().describe("Short description of what the command does"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background and return a task id immediately (default false). Use task_output/task_kill to inspect or stop it.",
    ),
});

export function killTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    }
    return;
  }
  // POSIX children spawn detached, so the pid leads a process group and a
  // negative-pid kill reaches shell grandchildren too.
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // group already gone (or not detached): fall back to the direct kill
    }
  }
  child.kill("SIGKILL");
}

// Bounds memory while a command streams: once the output passes MAX_OUTPUT
// the first half is kept verbatim, the second half rolls, and the dropped
// middle is counted so toString() matches truncating the unbounded string.
class BoundedOutput {
  private head = "";
  private tail = "";
  private dropped = 0;
  private overflow = false;

  append(text: string): void {
    if (!this.overflow) {
      this.head += text;
      if (this.head.length <= MAX_OUTPUT) {
        return;
      }
      this.overflow = true;
      this.tail = this.head.slice(HALF_OUTPUT);
      this.head = this.head.slice(0, HALF_OUTPUT);
      if (this.tail.length > HALF_OUTPUT) {
        this.dropped = this.tail.length - HALF_OUTPUT;
        this.tail = this.tail.slice(-HALF_OUTPUT);
      }
      return;
    }
    this.tail += text;
    if (this.tail.length > HALF_OUTPUT) {
      this.dropped += this.tail.length - HALF_OUTPUT;
      this.tail = this.tail.slice(-HALF_OUTPUT);
    }
  }

  toString(): string {
    if (!this.overflow) {
      return this.head;
    }
    return `${this.head}\n... [${this.dropped} characters truncated] ...\n${this.tail}`;
  }
}

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command (Git Bash on Windows when available, otherwise cmd; sh elsewhere). Stdout and stderr are merged. Output is truncated to 30000 characters. Set run_in_background for long-running commands; it returns a task id for task_list/task_output/task_kill.",
  permission: "exec",
  parameters: schema,
  execute(args, ctx) {
    if (args.run_in_background) {
      const task = defaultTaskManager.start({
        command: args.command,
        description: args.description,
        cwd: ctx.cwd,
        timeoutSeconds: args.timeout,
      });
      return Promise.resolve({
        content: `Background task started: ${task.id}\ncommand: ${args.command}\ndescription: ${args.description ?? "(none)"}`,
      });
    }
    const timeoutSeconds = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const spec = resolveShell();
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(spec.shell, spec.wrap(args.command), {
        cwd: ctx.cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      const output = new BoundedOutput();
      let settled = false;
      const finish = (result: ToolResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        killTree(child);
        finish({ content: `${output}\nCommand aborted`, isError: true });
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish({
          content: `${output}\nCommand timed out after ${timeoutSeconds}s`,
          isError: true,
        });
      }, timeoutSeconds * 1000);
      timer.unref();
      child.stdout.on("data", (d: Buffer) => output.append(d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => output.append(d.toString("utf8")));
      child.on("error", (err) => {
        finish({ content: `Failed to start shell '${spec.label}': ${err.message}`, isError: true });
      });
      ctx.abortSignal?.addEventListener("abort", onAbort);
      child.on("close", (code) => {
        const trimmed = output.toString().replace(/\s+$/, "");
        if (code === 0) {
          finish({ content: trimmed || "(no output)" });
          return;
        }
        finish({
          content: `${trimmed}${trimmed ? "\n" : ""}Exit code: ${code ?? "unknown"}`,
          isError: true,
        });
      });
    });
  },
};
