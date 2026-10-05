import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getEnvFileKeys } from "../config/env";
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
  // Portable fallback: the standard Git for Windows install locations, built
  // from the Program Files environment variables instead of hardcoded drives.
  const seen = new Set<string>();
  for (const root of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
  ]) {
    if (!root) continue;
    const candidate = path.join(root, "Git", "bin", "bash.exe");
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
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
// bytes the first half is kept verbatim, the second half rolls, and the
// dropped middle is counted so toString() matches truncating the unbounded
// output. Chunks accumulate as raw bytes and decode once in toString(), so
// a multi-byte character split across chunk boundaries stays intact.
class BoundedOutput {
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private dropped = 0;
  private overflow = false;

  append(chunk: Buffer): void {
    if (!this.overflow) {
      this.head = this.head.length === 0 ? chunk : Buffer.concat([this.head, chunk]);
      if (this.head.length <= MAX_OUTPUT) {
        return;
      }
      this.overflow = true;
      this.tail = this.head.subarray(HALF_OUTPUT);
      this.head = this.head.subarray(0, HALF_OUTPUT);
      if (this.tail.length > HALF_OUTPUT) {
        this.dropped = this.tail.length - HALF_OUTPUT;
        this.tail = this.tail.subarray(this.tail.length - HALF_OUTPUT);
      }
      return;
    }
    this.tail = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    if (this.tail.length > HALF_OUTPUT) {
      this.dropped += this.tail.length - HALF_OUTPUT;
      this.tail = this.tail.subarray(this.tail.length - HALF_OUTPUT);
    }
  }

  toString(): string {
    if (!this.overflow) {
      return decodeOutput(this.head);
    }
    // The head/tail seam can split a multi-byte character; drop the partial
    // sequence so it doesn't decode as U+FFFD (or trip the GBK fallback).
    const head = decodeOutput(trimUtf8End(this.head));
    const tail = decodeOutput(trimUtf8Start(this.tail));
    return `${head}\n... [${this.dropped} bytes truncated] ...\n${tail}`;
  }
}

// Drops a trailing incomplete UTF-8 sequence (1-3 bytes) so a truncation
// seam doesn't decode to U+FFFD; the other half of the character is gone
// either way.
export function trimUtf8End(buf: Buffer): Buffer {
  let cont = 0;
  let i = buf.length;
  while (i > 0 && cont < 3 && ((buf[i - 1] ?? 0) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i === 0) return buf;
  const lead = buf[i - 1] ?? 0;
  if (lead < 0x80 || (lead & 0xc0) === 0x80) return buf;
  const needed = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
  return cont < needed ? buf.subarray(0, i - 1) : buf;
}

// Drops leading UTF-8 continuation bytes: after truncating to a byte window
// the first bytes may be the tail of a character whose lead was cut.
export function trimUtf8Start(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && i < 3 && ((buf[i] ?? 0) & 0xc0) === 0x80) i++;
  return i === 0 ? buf : buf.subarray(i);
}

// Decodes captured child output once, after the chunks are concatenated.
// On Windows a UTF-8 decode failure means the bytes came from a native
// program writing the OEM codepage (GBK on Chinese systems) — Node ships
// full-icu, so the "gbk" TextDecoder label is always available as fallback.
export function decodeOutput(buf: Buffer, platform: NodeJS.Platform = process.platform): string {
  const text = buf.toString("utf8");
  if (platform === "win32" && text.includes("�")) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return text;
    }
  }
  return text;
}

// Environment for child processes: process.env minus the keys loadEnvFile
// read from ~/.star-cli/.env (API secrets). In auto mode a child could
// otherwise print them with `env` or exfiltrate via `curl $KEY`. The main
// process's own process.env keeps them for provider calls.
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of getEnvFileKeys()) {
    delete env[key];
  }
  return env;
}

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command (Git Bash on Windows when available, otherwise cmd; sh elsewhere). Stdout and stderr are merged. Output is truncated to 30000 bytes. Set run_in_background for long-running commands; it returns a task id for task_list/task_output/task_kill.",
  permission: "exec",
  parameters: schema,
  execute(args, ctx) {
    if (args.run_in_background) {
      const task = defaultTaskManager.start({
        command: args.command,
        description: args.description,
        cwd: ctx.cwd,
        timeoutSeconds: args.timeout,
        ownerId: ctx.agentId ?? "root",
        env: childEnv(),
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
        env: childEnv(),
        windowsHide: true,
        detached: process.platform !== "win32",
        // No stdin: a command that reads it (cat, read, input()) must get
        // EOF immediately instead of hanging until the timeout.
        stdio: ["ignore", "pipe", "pipe"],
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
      child.stdout.on("data", (d: Buffer) => output.append(d));
      child.stderr.on("data", (d: Buffer) => output.append(d));
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
