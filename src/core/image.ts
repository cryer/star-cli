import { responseBodyOf } from "./http-error";
import type { CoreMessage } from "./messages";

// Images with a longer side above this many pixels are downsampled before
// being sent (clipboard/@mention paths) and stripped on retry when a provider
// rejects them.
export const MAX_IMAGE_DIMENSION = 2000;
// Byte-size fallback for images whose dimensions cannot be probed.
export const OVERSIZED_IMAGE_FALLBACK_BYTES = 5 * 1024 * 1024;
export const IMAGE_REMOVED_PLACEHOLDER = "[image removed: too large for the model]";

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function probePng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Start-of-frame markers that carry dimensions (excludes DHT/JPG/DAC/RST).
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function probeJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function probeGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const signature = buf.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function probeWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const b1 = buf[21] as number;
    const b2 = buf[22] as number;
    const b3 = buf[23] as number;
    const b4 = buf[24] as number;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return null;
}

// Reads pixel dimensions straight from encoded image bytes; null when the
// format is unrecognized or the header is truncated.
export function probeImageDimensions(buf: Buffer): ImageDimensions | null {
  return probePng(buf) ?? probeJpeg(buf) ?? probeGif(buf) ?? probeWebp(buf);
}

// A provider rejected the request because of an oversized image: a 4xx naming
// images together with a size/dimension keyword. The message and the response
// body are tested together — relays often answer with a generic message and
// put the real reason in the body. Plain "request too large" or
// context-length errors never match — stripping images would not help those.
const IMAGE_SIZE_KEYWORDS =
  /too[\s-]*(large|big)|exceeds?|dimensions?|resolution|size\s*limit|max(?:imum)?[\s-]*size/i;

export function isOversizedImageError(error: Error): boolean {
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  const text = [error.message, responseBodyOf(error)]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return /image/i.test(text) && IMAGE_SIZE_KEYWORDS.test(text);
}

function imagePartBytes(image: unknown): Buffer | null {
  if (typeof image === "string") {
    const base64 = image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image;
    try {
      return Buffer.from(base64, "base64");
    } catch {
      return null;
    }
  }
  if (image instanceof Uint8Array) return Buffer.from(image);
  return null;
}

export function isOversizedImageData(buf: Buffer): boolean {
  const dims = probeImageDimensions(buf);
  if (dims) return Math.max(dims.width, dims.height) > MAX_IMAGE_DIMENSION;
  return buf.length > OVERSIZED_IMAGE_FALLBACK_BYTES;
}

// Replaces every oversized image part in the history with a text placeholder.
// Dimension-probeable images are judged by pixels; anything else falls back
// to the byte cap. The input array is not mutated.
export function stripOversizedImages(messages: CoreMessage[]): {
  messages: CoreMessage[];
  removed: number;
} {
  let removed = 0;
  const result = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "image") return part;
      const bytes = imagePartBytes(part.image);
      if (!bytes || !isOversizedImageData(bytes)) return part;
      changed = true;
      removed++;
      return { type: "text" as const, text: IMAGE_REMOVED_PLACEHOLDER };
    });
    return changed ? ({ ...message, content } as CoreMessage) : message;
  });
  return { messages: removed > 0 ? result : messages, removed };
}
