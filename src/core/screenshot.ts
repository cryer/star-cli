import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeImageDimensions } from "./image";
import { downsampleImageIfNeeded } from "./image-resize";
import type { ImageInput } from "./messages";

export const SCREENSHOT_TIMEOUT_MS = 20_000;

const execFileAsync = promisify(execFile);

export interface ScreenshotCommand {
  command: string;
  args: string[];
}

export type ScreenshotResult = { ok: true; image: ImageInput } | { ok: false; error: string };

// Windows capture script: copies the primary screen into a PNG. The position
// problem on Windows is DPI virtualization — when the process is not truly
// per-monitor DPI aware, the Bounds Forms reports and the pixels CopyFromScreen
// reads live in different coordinate spaces, so at 125%/150% scaling the
// capture comes out offset and wrongly sized. Setting per-monitor-V2 awareness
// before touching Forms/Drawing makes both sides physical pixels; the call
// fails harmlessly when the host manifest already pinned awareness (system
// awareness is still physically correct on the primary display).
export function windowsScreenshotScript(outputFile: string): string {
  const output = outputFile.replace(/'/g, "''");
  return [
    "try { Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(int v);' -Name Dpi -Namespace StarShot -ErrorAction Stop; [void][StarShot.Dpi]::SetProcessDpiAwarenessContext(-4) } catch { }",
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
    `$bmp.Save('${output}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
  ].join("; ");
}

// Platform-native capture command writing a PNG to outputFile, or null when
// this platform/session cannot take screenshots. Windows/macOS capture the
// primary display only — one deterministic file and physically exact bounds,
// even on mixed-DPI multi-monitor setups; Linux tools capture the whole
// compositor/root window (all monitors composited).
export function screenshotPlan(
  platform: NodeJS.Platform,
  outputFile: string,
  env: NodeJS.ProcessEnv = process.env,
  tools: Record<string, boolean> = {},
): ScreenshotCommand | null {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", windowsScreenshotScript(outputFile)],
    };
  }
  if (platform === "darwin") {
    // -x silences the shutter sound; -D 1 pins the main display so a single
    // output file is deterministic no matter how many monitors are attached.
    return { command: "screencapture", args: ["-x", "-D", "1", outputFile] };
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) {
      if (tools.grim) return { command: "grim", args: [outputFile] };
      if (tools["gnome-screenshot"]) {
        return { command: "gnome-screenshot", args: ["-f", outputFile] };
      }
      if (tools.spectacle) {
        return { command: "spectacle", args: ["-b", "-n", "-o", outputFile] };
      }
      return null;
    }
    if (env.DISPLAY) {
      if (tools.import) return { command: "import", args: ["-window", "root", outputFile] };
      if (tools.scrot) return { command: "scrot", args: ["--overwrite", outputFile] };
      if (tools["gnome-screenshot"]) {
        return { command: "gnome-screenshot", args: ["-f", outputFile] };
      }
      if (tools.spectacle) {
        return { command: "spectacle", args: ["-b", "-n", "-o", outputFile] };
      }
      return null;
    }
    return null;
  }
  return null;
}

export function noScreenshotToolMessage(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "linux") {
    if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
      return "no display server (neither DISPLAY nor WAYLAND_DISPLAY is set) — this session is headless (e.g. SSH), there is no screen to capture";
    }
    return "no screenshot tool found — install one of: grim or spectacle (Wayland), scrot or ImageMagick's import (X11), or gnome-screenshot";
  }
  return `screenshots are not supported on this platform (${platform})`;
}

async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command], { timeout: SCREENSHOT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

const LINUX_TOOL_NAMES = ["grim", "gnome-screenshot", "spectacle", "import", "scrot"];

// Captures the screen into a temp PNG via platform-native tools (no npm image
// dependency), downsamples past 2000px like read_image, and returns the image
// for the loop to attach to the history. Failures come back as messages the
// model can act on instead of exceptions.
export async function captureScreenshot(): Promise<ScreenshotResult> {
  const outputFile = path.join(os.tmpdir(), `star-screenshot-${randomUUID()}.png`);
  try {
    const tools: Record<string, boolean> = {};
    if (process.platform === "linux") {
      const found = await Promise.all(LINUX_TOOL_NAMES.map(commandExists));
      for (const [i, name] of LINUX_TOOL_NAMES.entries()) {
        tools[name] = found[i] ?? false;
      }
    }
    const plan = screenshotPlan(process.platform, outputFile, process.env, tools);
    if (!plan) {
      return { ok: false, error: noScreenshotToolMessage(process.platform) };
    }
    try {
      await execFileAsync(plan.command, plan.args, { timeout: SCREENSHOT_TIMEOUT_MS });
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
      return { ok: false, error: `${plan.command} failed to capture the screen${detail}` };
    }
    const buf = await readFile(outputFile).catch(() => null);
    if (!buf || buf.length === 0) {
      return { ok: false, error: `${plan.command} produced no image file` };
    }
    if (!probeImageDimensions(buf)) {
      return { ok: false, error: `${plan.command} produced an unrecognized image file` };
    }
    const downsampled = await downsampleImageIfNeeded({
      path: "screen",
      mimeType: "image/png",
      data: buf.toString("base64"),
    });
    if (downsampled.oversized && !downsampled.resized) {
      return {
        ok: false,
        error: "screenshot exceeds 2000px and could not be downsampled on this platform",
      };
    }
    return { ok: true, image: downsampled.image };
  } finally {
    await unlink(outputFile).catch(() => {});
  }
}
