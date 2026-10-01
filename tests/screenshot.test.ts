import { describe, expect, it } from "vitest";
import {
  noScreenshotToolMessage,
  screenshotPlan,
  windowsScreenshotScript,
} from "../src/core/screenshot";
import { createScreenshotTool } from "../src/tools/screenshot";

// Minimal PNG header with real dimensions (same trick as tests/read-image.test.ts).
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("screenshotPlan", () => {
  it("captures the primary screen on Windows with DPI-aware physical coordinates", () => {
    const plan = screenshotPlan("win32", "C:\\tmp\\shot.png", {});
    expect(plan?.command).toBe("powershell.exe");
    const script = plan?.args.at(-1) ?? "";
    // Per-monitor awareness keeps Bounds and CopyFromScreen in the same
    // physical pixel space, so the captured region is not offset under scaling.
    expect(script).toContain("SetProcessDpiAwarenessContext");
    expect(script).toContain("PrimaryScreen.Bounds");
    expect(script).toContain("CopyFromScreen");
    expect(script).toContain("C:\\tmp\\shot.png");
  });

  it("pins the main display on macOS for a deterministic single output file", () => {
    const plan = screenshotPlan("darwin", "/tmp/shot.png", {});
    expect(plan).toEqual({
      command: "screencapture",
      args: ["-x", "-D", "1", "/tmp/shot.png"],
    });
  });

  it("prefers grim on Wayland and import on X11, with fallbacks", () => {
    expect(
      screenshotPlan("linux", "/tmp/s.png", { WAYLAND_DISPLAY: "wayland-1" }, { grim: true }),
    ).toEqual({ command: "grim", args: ["/tmp/s.png"] });
    expect(
      screenshotPlan(
        "linux",
        "/tmp/s.png",
        { WAYLAND_DISPLAY: "wayland-1" },
        { "gnome-screenshot": true },
      ),
    ).toEqual({ command: "gnome-screenshot", args: ["-f", "/tmp/s.png"] });
    expect(
      screenshotPlan("linux", "/tmp/s.png", { DISPLAY: ":0" }, { import: true, scrot: true }),
    ).toEqual({ command: "import", args: ["-window", "root", "/tmp/s.png"] });
    expect(screenshotPlan("linux", "/tmp/s.png", { DISPLAY: ":0" }, { scrot: true })).toEqual({
      command: "scrot",
      args: ["--overwrite", "/tmp/s.png"],
    });
    expect(screenshotPlan("linux", "/tmp/s.png", { DISPLAY: ":0" }, { spectacle: true })).toEqual({
      command: "spectacle",
      args: ["-b", "-n", "-o", "/tmp/s.png"],
    });
  });

  it("returns null when the session is headless or no tool is available", () => {
    expect(screenshotPlan("linux", "/tmp/s.png", {}, {})).toBeNull();
    expect(screenshotPlan("linux", "/tmp/s.png", { DISPLAY: ":0" }, {})).toBeNull();
    expect(screenshotPlan("freebsd", "/tmp/s.png", {}, {})).toBeNull();
  });

  it("explains headless sessions and missing tools", () => {
    expect(noScreenshotToolMessage("linux", {})).toContain("headless");
    expect(noScreenshotToolMessage("linux", { DISPLAY: ":0" })).toContain("no screenshot tool");
    expect(noScreenshotToolMessage("freebsd", {})).toContain("freebsd");
  });

  it("escapes single quotes in the Windows output path", () => {
    const script = windowsScreenshotScript("C:\\tmp\\it's.png");
    expect(script).toContain("C:\\tmp\\it''s.png");
  });
});

describe("screenshot tool", () => {
  it("attaches the captured image with a descriptive text result", async () => {
    const tool = createScreenshotTool(async () => ({
      ok: true,
      image: {
        path: "screen",
        mimeType: "image/png",
        data: pngBuffer(1920, 1080).toString("base64"),
      },
    }));

    const result = await tool.execute({}, { cwd: process.cwd() });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1920x1080");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mimeType).toBe("image/png");
  });

  it("surfaces capture failures as actionable error text", async () => {
    const tool = createScreenshotTool(async () => ({
      ok: false,
      error: "no display server — headless",
    }));

    const result = await tool.execute({}, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("headless");
    expect(result.images).toBeUndefined();
  });
});
