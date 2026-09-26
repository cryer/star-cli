import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_IMAGE_DIMENSION, probeImageDimensions } from "../core/image";
import type { ImageInput } from "../core/messages";

export const RESIZE_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

export interface ResizeCommand {
  command: string;
  args: string[];
}

export function windowsResizeScript(
  inputFile: string,
  outputFile: string,
  maxDimension: number,
): string {
  const input = inputFile.replace(/'/g, "''");
  const output = outputFile.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Drawing",
    `$img = [System.Drawing.Image]::FromFile('${input}')`,
    `$scale = [Math]::Min(1.0, ${maxDimension} / [Math]::Max($img.Width, $img.Height))`,
    "$w = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))",
    "$h = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))",
    "$bmp = New-Object System.Drawing.Bitmap($w, $h)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "$g.DrawImage($img, 0, 0, $w, $h)",
    `$bmp.Save('${output}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose(); $img.Dispose()",
  ].join("; ");
}

// Platform-native resize command, or null when no tool is available. All
// variants keep the aspect ratio and bound the longest side to maxDimension;
// the output is always PNG.
export function resizeImagePlan(
  platform: NodeJS.Platform,
  inputFile: string,
  outputFile: string,
  maxDimension: number,
  tools: { hasConvert?: boolean; hasFfmpeg?: boolean } = {},
): ResizeCommand | null {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsResizeScript(inputFile, outputFile, maxDimension),
      ],
    };
  }
  if (platform === "darwin") {
    return {
      command: "sips",
      args: ["-Z", String(maxDimension), inputFile, "--out", outputFile],
    };
  }
  if (platform === "linux") {
    if (tools.hasConvert) {
      return {
        command: "convert",
        // -auto-orient keeps EXIF-rotated photos upright after the resize
        // strips their orientation metadata.
        args: [
          inputFile,
          "-auto-orient",
          "-resize",
          `${maxDimension}x${maxDimension}>`,
          outputFile,
        ],
      };
    }
    if (tools.hasFfmpeg) {
      return {
        command: "ffmpeg",
        args: [
          "-y",
          "-i",
          inputFile,
          "-vf",
          `scale='if(gt(iw,ih),min(iw,${maxDimension}),-1)':'if(gt(iw,ih),-1,min(ih,${maxDimension}))'`,
          outputFile,
        ],
      };
    }
    return null;
  }
  return null;
}

async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command], { timeout: RESIZE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export interface DownsampledImage {
  image: ImageInput;
  /** The source exceeded MAX_IMAGE_DIMENSION on its longest side. */
  oversized: boolean;
  /** The image was actually resized to fit; false when no platform tool was available or resizing failed. */
  resized: boolean;
}

// Downsamples an image whose longest side exceeds MAX_IMAGE_DIMENSION using
// platform-native tools (no npm image dependency). Undimensionable or small
// images pass through untouched; when resizing is impossible the original is
// kept with oversized=true so the caller can warn instead of failing silently.
export async function downsampleImageIfNeeded(image: ImageInput): Promise<DownsampledImage> {
  const buf = Buffer.from(image.data, "base64");
  const dims = probeImageDimensions(buf);
  if (!dims || Math.max(dims.width, dims.height) <= MAX_IMAGE_DIMENSION) {
    return { image, oversized: false, resized: false };
  }
  const inputFile = path.join(os.tmpdir(), `star-image-${randomUUID()}.src`);
  const outputFile = path.join(os.tmpdir(), `star-image-${randomUUID()}.png`);
  try {
    const [hasConvert, hasFfmpeg] =
      process.platform === "linux"
        ? await Promise.all([commandExists("convert"), commandExists("ffmpeg")])
        : [false, false];
    const plan = resizeImagePlan(process.platform, inputFile, outputFile, MAX_IMAGE_DIMENSION, {
      hasConvert,
      hasFfmpeg,
    });
    if (!plan) return { image, oversized: true, resized: false };
    await writeFile(inputFile, buf);
    await execFileAsync(plan.command, plan.args, { timeout: RESIZE_TIMEOUT_MS });
    const out = await readFile(outputFile).catch(() => null);
    if (!out || out.length === 0) return { image, oversized: true, resized: false };
    return {
      image: { path: image.path, mimeType: "image/png", data: out.toString("base64") },
      oversized: true,
      resized: true,
    };
  } catch {
    return { image, oversized: true, resized: false };
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  }
}
