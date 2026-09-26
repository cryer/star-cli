import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiffLines, generateDiffPreview } from "../src/cli/diff-preview";
import { renderApp, stripAnsi } from "./ink-harness";

// FORCE_COLOR is set by ./ink-harness before ink is loaded.
const { PermissionPrompt } = await import("../src/cli/components/PermissionPrompt");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-diff-preview-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildDiffLines", () => {
  it("marks changed lines with add/del and keeps surrounding context", () => {
    const lines = buildDiffLines("one\ntwo\nthree", "one\nTWO\nthree");
    expect(lines).toEqual([
      { kind: "context", text: "one" },
      { kind: "del", text: "two" },
      { kind: "add", text: "TWO" },
      { kind: "context", text: "three" },
    ]);
  });

  it("limits context to 2 lines around each change", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[10] = "changed";
    const lines = buildDiffLines(oldLines.join("\n"), newLines.join("\n"));
    expect(lines).toEqual([
      { kind: "context", text: "line8" },
      { kind: "context", text: "line9" },
      { kind: "del", text: "line10" },
      { kind: "add", text: "changed" },
      { kind: "context", text: "line11" },
      { kind: "context", text: "line12" },
    ]);
  });

  it("returns no lines when contents are identical", () => {
    expect(buildDiffLines("a\nb", "a\nb")).toEqual([]);
  });

  it("separates distant changes into hunks", () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[2] = "first";
    newLines[25] = "second";
    const lines = buildDiffLines(oldLines.join("\n"), newLines.join("\n"));
    expect(lines.some((l) => l.kind === "marker" && l.text === "···")).toBe(true);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["line2", "line25"]);
  });

  it("truncates large change blocks with a marker", () => {
    const oldText = ["head", ...Array.from({ length: 30 }, (_, i) => `old${i}`), "tail"].join("\n");
    const newText = ["head", ...Array.from({ length: 30 }, (_, i) => `new${i}`), "tail"].join("\n");
    const lines = buildDiffLines(oldText, newText);
    expect(lines.length).toBeLessThanOrEqual(13);
    const marker = lines[lines.length - 1];
    expect(marker?.kind).toBe("marker");
    expect(marker?.text).toMatch(/^\.\.\. \(\d+ more lines\)$/);
    expect(lines.filter((l) => l.kind === "del").length).toBeGreaterThan(0);
    expect(lines.some((l) => l.kind === "add")).toBe(true);
  });

  it("caps the total output at 12 lines plus a marker", () => {
    const oldLines = Array.from({ length: 60 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    for (const i of [0, 10, 20, 30, 40, 50]) newLines[i] = `changed${i}`;
    const lines = buildDiffLines(oldLines.join("\n"), newLines.join("\n"));
    expect(lines.length).toBe(13);
    expect(lines[lines.length - 1]?.text).toMatch(/^\.\.\. \(\d+ more lines\)$/);
  });
});

describe("generateDiffPreview", () => {
  it("builds a diff for edit_file on an existing file", async () => {
    writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    const preview = await generateDiffPreview(
      "edit_file",
      { path: "a.txt", old_string: "beta", new_string: "BETA" },
      dir,
    );
    expect(preview).not.toBeNull();
    expect(preview?.type).toBe("diff");
    expect(preview?.label).toBe("a.txt");
    expect(preview?.lines).toContainEqual({ kind: "del", text: "beta" });
    expect(preview?.lines).toContainEqual({ kind: "add", text: "BETA" });
  });

  it("returns null for edit_file when the file does not exist", async () => {
    const preview = await generateDiffPreview(
      "edit_file",
      { path: "missing.txt", old_string: "x", new_string: "y" },
      dir,
    );
    expect(preview).toBeNull();
  });

  it("returns null for edit_file when old_string is not found", async () => {
    writeFileSync(path.join(dir, "a.txt"), "alpha\n");
    const preview = await generateDiffPreview(
      "edit_file",
      { path: "a.txt", old_string: "nope", new_string: "y" },
      dir,
    );
    expect(preview).toBeNull();
  });

  it("previews the first lines of a new file for write_file", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `row${i}`).join("\n");
    const preview = await generateDiffPreview("write_file", { path: "new.txt", content }, dir);
    expect(preview?.type).toBe("new-file");
    expect(preview?.label).toBe("new.txt");
    expect(preview?.lines.length).toBe(11);
    expect(preview?.lines[0]).toEqual({ kind: "add", text: "row0" });
    expect(preview?.lines[9]).toEqual({ kind: "add", text: "row9" });
    expect(preview?.lines[10]).toEqual({ kind: "marker", text: "... (10 more lines)" });
  });

  it("treats $ sequences in the replacement literally, matching edit_file", async () => {
    writeFileSync(path.join(dir, "dollar.txt"), "a=1\n");
    const replacement = String.raw`sed 's/$&/$$1/g' $1`;
    const preview = await generateDiffPreview(
      "edit_file",
      { path: "dollar.txt", old_string: "a=1", new_string: replacement },
      dir,
    );
    expect(preview).not.toBeNull();
    expect(preview?.lines).toContainEqual({ kind: "add", text: replacement });
  });

  it("builds a diff for write_file on an existing file", async () => {
    writeFileSync(path.join(dir, "a.txt"), "old content\n");
    const preview = await generateDiffPreview(
      "write_file",
      { path: "a.txt", content: "new content\n" },
      dir,
    );
    expect(preview?.type).toBe("diff");
    expect(preview?.lines).toContainEqual({ kind: "del", text: "old content" });
    expect(preview?.lines).toContainEqual({ kind: "add", text: "new content" });
  });

  it("returns null for tools without diff support", async () => {
    expect(await generateDiffPreview("bash", { command: "ls" }, dir)).toBeNull();
  });
});

describe("PermissionPrompt diff rendering", () => {
  const request = {
    toolName: "edit_file",
    args: { path: "a.txt", old_string: "beta", new_string: "BETA" },
    level: "write" as const,
  };

  it("renders added and removed lines", async () => {
    writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    const diff = await generateDiffPreview(
      "edit_file",
      { path: "a.txt", old_string: "beta", new_string: "BETA" },
      dir,
    );
    const onDecision = vi.fn();
    const app = renderApp(createElement(PermissionPrompt, { request, preview: diff, onDecision }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = app.lastFrame() ?? "";
    const plain = stripAnsi(frame);
    expect(plain).toContain("- beta");
    expect(plain).toContain("+ BETA");
    expect(plain).toContain("alpha");
    app.unmount();
  });

  it("colors added lines green and removed lines red", async () => {
    writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    const diff = await generateDiffPreview(
      "edit_file",
      { path: "a.txt", old_string: "beta", new_string: "BETA" },
      dir,
    );
    const app = renderApp(
      createElement(PermissionPrompt, { request, preview: diff, onDecision: vi.fn() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("\u001B[32m+ BETA");
    expect(frame).toContain("\u001B[31m- beta");
    app.unmount();
  });

  it("falls back to the args summary without a preview", async () => {
    const app = renderApp(
      createElement(PermissionPrompt, {
        request: { toolName: "bash", args: { command: "ls -la" }, level: "write" as const },
        preview: null,
        onDecision: vi.fn(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const plain = stripAnsi(app.lastFrame() ?? "");
    expect(plain).toContain("ls -la");
    app.unmount();
  });
});
