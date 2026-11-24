import { type ChildProcess, spawn } from "node:child_process";

const WINDOWS_KILL_TIMEOUT_MS = 2000;

export function directKill(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {}
}

function runKillCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      resolve(success);
    };
    const onError = () => finish(false);
    const onClose = (code: number | null) => finish(code === 0);
    const timer = setTimeout(() => {
      directKill(child);
      finish(false);
    }, WINDOWS_KILL_TIMEOUT_MS);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export async function killTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    if (!child.pid) {
      directKill(child);
      return;
    }
    if (await runKillCommand("taskkill", ["/pid", String(child.pid), "/T", "/F"])) return;
    const script = `$root = ${child.pid}; $processes = Get-CimInstance Win32_Process; function Stop-Tree { param([int]$Id) foreach ($descendant in @($processes | Where-Object { $_.ParentProcessId -eq $Id })) { Stop-Tree $descendant.ProcessId }; Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue }; Stop-Tree $root`;
    await runKillCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    directKill(child);
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  directKill(child);
}
