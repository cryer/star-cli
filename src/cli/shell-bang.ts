import { isDangerousCommand } from "../permissions/gate";
import { bashTool } from "../tools/bash";

export const SHELL_BANG_DISPLAY_MAX_CHARS = 3000;

export type ShellBangOutcome =
  | {
      ok: true;
      command: string;
      output: string;
      isError: boolean;
      contextMessage: string;
    }
  | { ok: false; reason: "empty" | "dangerous" };

export function truncateShellOutput(
  output: string,
  max: number = SHELL_BANG_DISPLAY_MAX_CHARS,
): string {
  if (output.length <= max) return output;
  const half = Math.floor(max / 2);
  return `${output.slice(0, half)}\n... [${output.length - max} characters truncated] ...\n${output.slice(-half)}`;
}

export function buildShellContextMessage(command: string, output: string): string {
  return `The user ran \`!${command}\` directly in the shell (no permission prompt). Output:\n${output}`;
}

export async function executeShellBang(
  raw: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ShellBangOutcome> {
  const command = raw.trim();
  if (!command) return { ok: false, reason: "empty" };
  if (isDangerousCommand(command)) return { ok: false, reason: "dangerous" };
  const result = await bashTool.execute({ command }, { cwd, abortSignal: signal });
  const output = truncateShellOutput(result.content);
  return {
    ok: true,
    command,
    output,
    isError: result.isError ?? false,
    contextMessage: buildShellContextMessage(command, output),
  };
}
