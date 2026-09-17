import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "./types";

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 120;
const MAX_TIMEOUT = 600;

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
    "Execute a shell command (Git Bash on Windows, sh elsewhere). Stdout and stderr are merged. Output is truncated to 30000 characters.",
  permission: "exec",
  parameters: schema,
  execute(args, ctx) {
    const timeoutSeconds = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const shell = process.platform === "win32" ? "bash" : "sh";
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(shell, ["-c", args.command], { cwd: ctx.cwd, windowsHide: true });
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
        child.kill();
        finish({ content: `${truncateMiddle(output)}\nCommand aborted`, isError: true });
      };
      const timer = setTimeout(() => {
        child.kill();
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
        finish({ content: `Failed to start shell '${shell}': ${err.message}`, isError: true });
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
