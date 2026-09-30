import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { probeImageDimensions } from "../../core/image";
import { downsampleImageIfNeeded } from "../../core/image-resize";
import type { ImageInput } from "../../core/messages";
import type { Tool } from "../types";
import { isSensitivePath } from "./util";

// Same ceiling as @-mention image reads (src/cli/mentions.ts).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const schema = z.object({
  path: z
    .string()
    .describe(
      "Image file path (png/jpg/jpeg/gif/webp), absolute or relative to the working directory",
    ),
});

// Lets the model pull an image into the conversation mid-session (a screenshot
// the user mentioned, a generated asset, a UI mock). The image itself is not
// in the text result — the loop attaches it to the history as a user message
// with image parts (see ToolResult.images), so every protocol sees it the same
// way as a pasted image.
export const readImageTool: Tool<typeof schema> = {
  name: "read_image",
  description:
    "Read an image file (png, jpg, gif, webp) and show it to the model. Use this whenever the user references a screenshot, diagram, or picture file you need to see. Images larger than 2000px are downsampled automatically.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    // Same symlink-aware sensitive check as read_file.
    const resolvedPath = await realpath(filePath).catch(() => null);
    if (isSensitivePath(filePath) || (resolvedPath !== null && isSensitivePath(resolvedPath))) {
      return { content: `Refused to read sensitive file: ${args.path}`, isError: true };
    }
    const mimeType = IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()];
    if (!mimeType) {
      return {
        content: `Not a supported image (png/jpg/jpeg/gif/webp): ${args.path}`,
        isError: true,
      };
    }
    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) {
      return { content: `File not found: ${args.path}`, isError: true };
    }
    if (st.size > MAX_IMAGE_BYTES) {
      return {
        content: `Image too large (${Math.round(st.size / 1024)}KB > ${MAX_IMAGE_BYTES / 1024}KB): ${args.path}`,
        isError: true,
      };
    }
    const buf = await readFile(filePath).catch(() => null);
    if (!buf || buf.length === 0) {
      return { content: `Failed to read ${args.path}`, isError: true };
    }
    if (!probeImageDimensions(buf)) {
      return {
        content: `File is not a valid image (unrecognized header): ${args.path}`,
        isError: true,
      };
    }
    const downsampled = await downsampleImageIfNeeded({
      path: args.path,
      mimeType,
      data: buf.toString("base64"),
    });
    if (downsampled.oversized && !downsampled.resized) {
      return {
        content: `Image exceeds 2000px and could not be downsampled on this platform: ${args.path}`,
        isError: true,
      };
    }
    const image: ImageInput = downsampled.image;
    const dims = probeImageDimensions(Buffer.from(image.data, "base64"));
    const sizeKB = Math.round(image.data.length / 1024);
    const desc = dims ? `${dims.width}x${dims.height}` : "unknown dimensions";
    const resizedNote = downsampled.resized ? " (downsampled to fit 2000px)" : "";
    return {
      content: `Image loaded: ${args.path} (${desc}, ~${sizeKB}KB)${resizedNote}. The image is attached below — look at it now.`,
      images: [image],
    };
  },
};
