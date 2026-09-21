import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAtToken, suggestPaths } from "../src/cli/path-suggest";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

const { InputBox } = await import("../src/cli/components/InputBox");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-path-suggest-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# hi");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "src", "cli"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, ".hidden"), "");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractAtToken", () => {
  it("extracts the token at the cursor", () => {
    expect(extractAtToken("@src", 4)).toEqual({ token: "src", start: 0, end: 4 });
    expect(extractAtToken("hello @src", 10)).toEqual({ token: "src", start: 6, end: 10 });
    expect(extractAtToken("hello @", 7)).toEqual({ token: "", start: 6, end: 7 });
  });

  it("returns null without an @ token before the cursor", () => {
    expect(extractAtToken("hello", 5)).toBeNull();
    expect(extractAtToken("", 0)).toBeNull();
    expect(extractAtToken("hello @src ", 11)).toBeNull();
  });

  it("extracts the token head when the cursor sits mid-token", () => {
    expect(extractAtToken("@src x", 4)).toEqual({ token: "src", start: 0, end: 4 });
  });
});

describe("suggestPaths", () => {
  it("prefix-matches files in the cwd", async () => {
    const results = await suggestPaths("RE", dir);
    expect(results).toEqual([{ path: "README.md", isDir: false }]);
  });

  it("marks directories with a trailing slash", async () => {
    const results = await suggestPaths("s", dir);
    expect(results).toEqual([{ path: "src/", isDir: true }]);
  });

  it("descends into a typed directory", async () => {
    const results = await suggestPaths("src/", dir);
    expect(results.map((r) => r.path)).toEqual(["src/cli/", "src/index.ts"]);
  });

  it("matches a segment prefix inside a directory", async () => {
    const results = await suggestPaths("src/c", dir);
    expect(results).toEqual([{ path: "src/cli/", isDir: true }]);
  });

  it("excludes node_modules, .git and dist", async () => {
    const all = await suggestPaths("", dir);
    expect(all.map((r) => r.path)).not.toContain("node_modules/");
    expect(all.map((r) => r.path)).not.toContain(".git/");
    expect(all.map((r) => r.path)).not.toContain("dist/");
    expect(await suggestPaths("node", dir)).toEqual([]);
  });

  it("refuses to descend into an excluded directory", async () => {
    expect(await suggestPaths("node_modules/", dir)).toEqual([]);
  });

  it("hides dotfiles unless the prefix starts with a dot", async () => {
    const all = await suggestPaths("", dir);
    expect(all.map((r) => r.path)).not.toContain(".hidden");
    const dotted = await suggestPaths(".h", dir);
    expect(dotted).toEqual([{ path: ".hidden", isDir: false }]);
  });

  it("returns nothing for a missing directory", async () => {
    expect(await suggestPaths("nope/", dir)).toEqual([]);
  });

  it("stops scanning at the entry cap", async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `cap-${String(i).padStart(2, "0")}.txt`), "");
    }
    const results = await suggestPaths("cap-", dir, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

const TAB = "\t";
const ENTER = "\r";

describe("InputBox @ path completion", () => {
  function setup(cwd: string) {
    const onSubmit = vi.fn();
    const app = renderApp(
      createElement(InputBox, {
        isStreaming: false,
        cwd,
        onSubmit,
        onInterrupt: () => {},
        onExit: () => {},
      }),
    );
    return { app, onSubmit };
  }

  it("suggests a matching file and completes it on tab", async () => {
    const { app, onSubmit } = setup(dir);
    await typeText(app.stdin, "@RE");
    await tick();
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("@README.md");
    await typeText(app.stdin, TAB, ENTER);
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("@README.md"));
    app.unmount();
  });

  it("descends into a directory on tab", async () => {
    const { app } = setup(dir);
    await typeText(app.stdin, "@s");
    await tick();
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("@src/");
    await typeText(app.stdin, TAB);
    await tick();
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("@src/cli/");
    expect(frame).toContain("@src/index.ts");
    app.unmount();
  });

  it("shows no path suggestions for plain text", async () => {
    const { app } = setup(dir);
    await typeText(app.stdin, "hello");
    await tick();
    await tick();
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("@README.md");
    app.unmount();
  });
});
