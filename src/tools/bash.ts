import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./types";

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 120;
const MAX_TIMEOUT = 600;

interface ShellSpec {
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

function resolveShell(): ShellSpec {
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

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z
    .number()
    .positive()
    .max(MAX_TIMEOUT)
    .optional()
    .describe("Timeout in seconds (default 120, max 600)"),
  description: z.string().optional().describe("Short description of what the command does"),
});

function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  child.kill("SIGKILL");
}

function truncateMiddle(s: string): string {
  if (s.length <= MAX_OUTPUT) {
    return s;
  }
  const half = Math.floor(MAX_OUTPUT / 2);
  const head = s.slice(0, half);
  const tail = s.slice(-half);
  return `${head}\n... [${s.length - MAX_OUTPUT} characters truncated] ...\n${tail}`;
}

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command (Git Bash on Windows when available, otherwise cmd; sh elsewhere). Stdout and stderr are merged. Output is truncated to 30000 characters.",
  permission: "exec",
  parameters: schema,
  execute(args, ctx) {
    const timeoutSeconds = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const spec = resolveShell();
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(spec.shell, spec.wrap(args.command), {
        cwd: ctx.cwd,
        windowsHide: true,
      });
      let output = "";
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
        finish({ content: `${truncateMiddle(output)}\nCommand aborted`, isError: true });
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish({
          content: `${truncateMiddle(output)}\nCommand timed out after ${timeoutSeconds}s`,
          isError: true,
        });
      }, timeoutSeconds * 1000);
      child.stdout.on("data", (d: Buffer) => {
        output += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        output += d.toString("utf8");
      });
      child.on("error", (err) => {
        finish({ content: `Failed to start shell '${spec.label}': ${err.message}`, isError: true });
      });
      ctx.abortSignal?.addEventListener("abort", onAbort);
      child.on("close", (code) => {
        const trimmed = output.replace(/\s+$/, "");
        if (code === 0) {
          finish({ content: truncateMiddle(trimmed) || "(no output)" });
          return;
        }
        const body = truncateMiddle(trimmed);
        finish({
          content: `${body}${body ? "\n" : ""}Exit code: ${code ?? "unknown"}`,
          isError: true,
        });
      });
    });
  },
};
