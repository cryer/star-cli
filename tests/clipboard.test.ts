import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  clipboardCopyCommand,
  clipboardImagePlan,
  macOsClipboardImageLines,
  readClipboardTempFile,
  windowsClipboardImageScript,
} from "../src/cli/clipboard";

describe("clipboardImagePlan", () => {
  it("uses PowerShell with a temp-file save on Windows", () => {
    const plan = clipboardImagePlan("win32", "C:\\tmp\\x.png", false);
    expect(plan?.kind).toBe("temp-file");
    expect(plan?.command).toBe("powershell.exe");
    expect(plan?.args).toContain("-STA");
    expect(plan?.args.join(" ")).toContain("GetImage()");
  });

  it("prefers pngpaste on macOS when available", () => {
    const plan = clipboardImagePlan("darwin", "/tmp/x.png", true);
    expect(plan).toEqual({ kind: "temp-file", command: "pngpaste", args: ["/tmp/x.png"] });
  });

  it("falls back to osascript on macOS without pngpaste", () => {
    const plan = clipboardImagePlan("darwin", "/tmp/x.png", false);
    expect(plan?.command).toBe("osascript");
    expect(plan?.args.join(" ")).toContain("PNGf");
  });

  it("streams from xclip on Linux", () => {
    const plan = clipboardImagePlan("linux", "/tmp/x.png", false);
    expect(plan).toEqual({
      kind: "stdout",
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    });
  });

  it("returns null on unsupported platforms", () => {
    expect(clipboardImagePlan("freebsd", "/tmp/x.png", false)).toBeNull();
  });
});

describe("clipboardCopyCommand", () => {
  it("picks the platform copy command", () => {
    expect(clipboardCopyCommand("win32")?.command).toBe("clip.exe");
    expect(clipboardCopyCommand("darwin")).toEqual({ command: "pbcopy", args: [] });
    expect(clipboardCopyCommand("linux")).toEqual({
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
    expect(clipboardCopyCommand("freebsd")).toBeNull();
  });
});

describe("clipboard scripts", () => {
  it("escapes single quotes in the Windows temp path", () => {
    const script = windowsClipboardImageScript("C:\\tmp\\it's.png");
    expect(script).toContain("it''s.png");
  });

  it("escapes quotes in the macOS temp path", () => {
    const lines = macOsClipboardImageLines('/tmp/x"y.png');
    expect(lines.join("\n")).toContain('POSIX file "/tmp/x\\"y.png"');
  });
});

describe("readClipboardTempFile", () => {
  it("reads a small PNG and rejects oversized, empty or missing files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "star-clipboard-"));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const small = path.join(dir, "ok.png");
      writeFileSync(small, png);
      const image = await readClipboardTempFile(small);
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(png.toString("base64"));

      const huge = path.join(dir, "huge.png");
      writeFileSync(huge, Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1));
      expect(await readClipboardTempFile(huge)).toBeNull();

      writeFileSync(path.join(dir, "empty.png"), "");
      expect(await readClipboardTempFile(path.join(dir, "empty.png"))).toBeNull();
      expect(await readClipboardTempFile(path.join(dir, "missing.png"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
