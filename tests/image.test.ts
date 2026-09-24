import { describe, expect, it } from "vitest";
import { resizeImagePlan, windowsResizeScript } from "../src/cli/image";
import {
  IMAGE_REMOVED_PLACEHOLDER,
  MAX_IMAGE_DIMENSION,
  isOversizedImageError,
  probeImageDimensions,
  stripOversizedImages,
} from "../src/core/image";
import type { CoreMessage } from "../src/core/messages";

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBuffer(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...new Array<number>(6).fill(0),
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof]);
}

function gifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8xBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe("probeImageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    expect(probeImageDimensions(pngBuffer(4096, 1024))).toEqual({ width: 4096, height: 1024 });
  });

  it("reads JPEG dimensions from the SOF segment", () => {
    expect(probeImageDimensions(jpegBuffer(3000, 2000))).toEqual({ width: 3000, height: 2000 });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    expect(probeImageDimensions(gifBuffer(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("reads WebP VP8X dimensions", () => {
    expect(probeImageDimensions(webpVp8xBuffer(2500, 1200))).toEqual({ width: 2500, height: 1200 });
  });

  it("returns null for garbage or truncated input", () => {
    expect(probeImageDimensions(Buffer.from("not an image at all, definitely"))).toBeNull();
    expect(probeImageDimensions(pngBuffer(100, 100).subarray(0, 10))).toBeNull();
    expect(probeImageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe("isOversizedImageError", () => {
  function apiError(message: string, statusCode: number): Error {
    const error = new Error(message);
    error.name = "AI_APICallError";
    (error as unknown as { statusCode: number }).statusCode = statusCode;
    return error;
  }

  it("matches 4xx errors naming image size or dimensions", () => {
    expect(
      isOversizedImageError(
        apiError("At least one of the image dimensions exceed max allowed size", 400),
      ),
    ).toBe(true);
    expect(isOversizedImageError(apiError("image exceeds 5 MB maximum", 400))).toBe(true);
    expect(isOversizedImageError(apiError("The image is too large", 413))).toBe(true);
    expect(isOversizedImageError(apiError("image resolution too high for this model", 400))).toBe(
      true,
    );
  });

  it("does not match unrelated 4xx errors", () => {
    expect(isOversizedImageError(apiError("Incorrect API key provided", 401))).toBe(false);
    expect(isOversizedImageError(apiError("context length exceeded", 400))).toBe(false);
    expect(isOversizedImageError(apiError("request entity too large", 413))).toBe(false);
    expect(isOversizedImageError(apiError("invalid request: bad tool schema", 400))).toBe(false);
  });

  it("does not match server errors or errors without a status", () => {
    expect(isOversizedImageError(apiError("image too large", 500))).toBe(false);
    expect(isOversizedImageError(new Error("image too large"))).toBe(false);
  });
});

describe("stripOversizedImages", () => {
  const oversizedPng = pngBuffer(MAX_IMAGE_DIMENSION + 500, 100).toString("base64");
  const smallPng = pngBuffer(100, 100).toString("base64");

  it("replaces oversized image parts with a placeholder and keeps small ones", () => {
    const messages: CoreMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "image", image: oversizedPng, mimeType: "image/png" },
          { type: "image", image: smallPng, mimeType: "image/png" },
          { type: "text", text: "what are these?" },
        ],
      },
      { role: "assistant", content: "plain reply" },
    ];

    const { messages: stripped, removed } = stripOversizedImages(messages);

    expect(removed).toBe(1);
    const user = stripped[1];
    expect(user?.role).toBe("user");
    expect(Array.isArray(user?.content) && user.content[0]).toEqual({
      type: "text",
      text: IMAGE_REMOVED_PLACEHOLDER,
    });
    expect(Array.isArray(user?.content) && user.content[1]).toEqual({
      type: "image",
      image: smallPng,
      mimeType: "image/png",
    });
    expect(stripped[2]).toBe(messages[2]);
    // The input is not mutated.
    expect(Array.isArray(messages[1]?.content) && messages[1].content[0]).toMatchObject({
      type: "image",
    });
  });

  it("strips undimensionable images past the byte fallback", () => {
    const hugeGarbage = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString("base64");
    const messages: CoreMessage[] = [
      { role: "user", content: [{ type: "image", image: hugeGarbage, mimeType: "image/png" }] },
    ];

    const { removed } = stripOversizedImages(messages);
    expect(removed).toBe(1);
  });

  it("accepts data URLs and Uint8Array image payloads", () => {
    const messages: CoreMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: `data:image/png;base64,${oversizedPng}` },
          { type: "image", image: pngBuffer(4000, 4000) },
        ],
      },
    ];

    const { removed } = stripOversizedImages(messages);
    expect(removed).toBe(2);
  });

  it("returns the original array when nothing is oversized", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: [{ type: "image", image: smallPng, mimeType: "image/png" }] },
    ];

    const result = stripOversizedImages(messages);
    expect(result.removed).toBe(0);
    expect(result.messages).toBe(messages);
  });
});

describe("resizeImagePlan", () => {
  it("uses PowerShell System.Drawing on Windows", () => {
    const plan = resizeImagePlan("win32", "C:\\tmp\\in.png", "C:\\tmp\\out.png", 2000);
    expect(plan?.command).toBe("powershell.exe");
    expect(plan?.args.join(" ")).toContain("System.Drawing");
    expect(plan?.args.join(" ")).toContain("2000");
  });

  it("uses sips on macOS", () => {
    const plan = resizeImagePlan("darwin", "/tmp/in.png", "/tmp/out.png", 2000);
    expect(plan).toEqual({
      command: "sips",
      args: ["-Z", "2000", "/tmp/in.png", "--out", "/tmp/out.png"],
    });
  });

  it("prefers ImageMagick convert on Linux", () => {
    const plan = resizeImagePlan("linux", "/tmp/in.png", "/tmp/out.png", 2000, {
      hasConvert: true,
      hasFfmpeg: true,
    });
    expect(plan).toEqual({
      command: "convert",
      args: ["/tmp/in.png", "-resize", "2000x2000>", "/tmp/out.png"],
    });
  });

  it("falls back to ffmpeg on Linux without convert", () => {
    const plan = resizeImagePlan("linux", "/tmp/in.png", "/tmp/out.png", 2000, {
      hasFfmpeg: true,
    });
    expect(plan?.command).toBe("ffmpeg");
    expect(plan?.args.join(" ")).toContain("scale=");
  });

  it("gives up on Linux with no tool and on unknown platforms", () => {
    expect(resizeImagePlan("linux", "/tmp/in.png", "/tmp/out.png", 2000)).toBeNull();
    expect(resizeImagePlan("freebsd", "/tmp/in.png", "/tmp/out.png", 2000)).toBeNull();
  });

  it("escapes single quotes in Windows paths", () => {
    const script = windowsResizeScript("C:\\tmp\\it's.png", "C:\\tmp\\out.png", 2000);
    expect(script).toContain("it''s.png");
  });
});
