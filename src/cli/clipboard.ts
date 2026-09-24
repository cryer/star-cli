import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ImageInput } from "../core/messages";
import { downsampleImageIfNeeded } from "./image";

export const CLIPBOARD_TIMEOUT_MS = 5000;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export type ClipboardImagePlan =
  | { kind: "temp-file"; command: string; args: string[] }
  | { kind: "stdout"; command: string; args: string[] };

// PowerShell saves the clipboard image to the temp PNG; with no image on the
// clipboard it writes nothing and the missing file is the "empty" signal.
export function windowsClipboardImageScript(tempFile: string): string {
  const escaped = tempFile.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [Windows.Forms.Clipboard]::GetImage()",
    "if ($null -ne $img) {",
    `  $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "  $img.Dispose()",
    "}",
  ].join("; ");
}

// osascript line set: `the clipboard as «class PNGf»` errors when the
// clipboard holds no PNG, which surfaces as a non-zero exit.
export function macOsClipboardImageLines(tempFile: string): string[] {
  const posix = tempFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "set pngData to the clipboard as «class PNGf»",
    `set theFile to open for access (POSIX file "${posix}") with write permission`,
    "write pngData to theFile",
    "close access theFile",
  ];
}

export function clipboardImagePlan(
  platform: NodeJS.Platform,
  tempFile: string,
  hasPngpaste: boolean,
): ClipboardImagePlan | null {
  if (platform === "win32") {
    return {
      kind: "temp-file",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        windowsClipboardImageScript(tempFile),
      ],
    };
  }
  if (platform === "darwin") {
    if (hasPngpaste) {
      return { kind: "temp-file", command: "pngpaste", args: [tempFile] };
    }
    return {
      kind: "temp-file",
      command: "osascript",
      args: macOsClipboardImageLines(tempFile).flatMap((line) => ["-e", line]),
    };
  }
  if (platform === "linux") {
    return {
      kind: "stdout",
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    };
  }
  return null;
}

export function clipboardCopyCommand(
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  if (platform === "win32") return { command: "clip.exe", args: [] };
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  if (platform === "linux") return { command: "xclip", args: ["-selection", "clipboard"] };
  return null;
}

async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command], { timeout: CLIPBOARD_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export interface ClipboardImage {
  image: ImageInput;
  /** The source exceeded the model-friendly dimension cap but could not be
   * resized (no platform tool or resize failure) — the caller should warn. */
  oversized: boolean;
}

async function finalizeClipboardImage(image: ImageInput): Promise<ClipboardImage> {
  const result = await downsampleImageIfNeeded(image);
  return { image: result.image, oversized: result.oversized && !result.resized };
}

// Reads a PNG image from the system clipboard, downsampling anything larger
// than MAX_IMAGE_DIMENSION on its longest side. Every read failure —
// unsupported platform, missing tool, no image on the clipboard, timeout —
// returns null.
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const tempFile = path.join(os.tmpdir(), `star-clipboard-${randomUUID()}.png`);
  const hasPngpaste = process.platform === "darwin" ? await commandExists("pngpaste") : false;
  const plan = clipboardImagePlan(process.platform, tempFile, hasPngpaste);
  if (!plan) return null;
  try {
    if (plan.kind === "stdout") {
      const { stdout } = await execFileAsync(plan.command, plan.args, {
        timeout: CLIPBOARD_TIMEOUT_MS,
        maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES,
        encoding: "buffer",
      });
      const buf = stdout as unknown as Buffer;
      if (buf.length === 0) return null;
      return finalizeClipboardImage({
        path: "clipboard.png",
        mimeType: "image/png",
        data: buf.toString("base64"),
      });
    }
    await execFileAsync(plan.command, plan.args, { timeout: CLIPBOARD_TIMEOUT_MS });
    const buf = await readFile(tempFile).catch(() => null);
    if (!buf || buf.length === 0) return null;
    return finalizeClipboardImage({
      path: "clipboard.png",
      mimeType: "image/png",
      data: buf.toString("base64"),
    });
  } catch {
    return null;
  } finally {
    if (plan.kind === "temp-file") {
      await unlink(tempFile).catch(() => {});
    }
  }
}

// Copies text to the system clipboard; false on any failure.
export async function copyText(text: string): Promise<boolean> {
  const plan = clipboardCopyCommand(process.platform);
  if (!plan) return false;
  return new Promise((resolve) => {
    const child = execFile(plan.command, plan.args, { timeout: CLIPBOARD_TIMEOUT_MS }, (error) =>
      resolve(error === null),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
