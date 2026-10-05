import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../src/permissions/gate";
import { compiledRules } from "../src/permissions/rules";
import { lexShell } from "../src/permissions/shell";
import type { PermissionContext, PermissionRequest } from "../src/permissions/types";
import type { PermissionLevel } from "../src/tools/types";

// Wrap the lexer in a spy. gate.ts/allow.ts no longer import lexShell
// directly — every lex goes through the per-check memo in lex-cache.ts, which
// imports it here — so the spy counts exactly the real lexing work.
vi.mock("../src/permissions/shell", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/permissions/shell")>();
  return { ...mod, lexShell: vi.fn(mod.lexShell) };
});

const lexSpy = vi.mocked(lexShell);

const testCwd = path.join(path.parse(process.cwd()).root, "star_test_cwd");
const ctx: PermissionContext = { cwd: testCwd };

function req(toolName: string, args: unknown, level: PermissionLevel): PermissionRequest {
  return { toolName, args, level };
}

describe("lexShell memoization within one check", () => {
  beforeEach(() => {
    lexSpy.mockClear();
  });

  it("lexes the command line once across all gate stages and rule tiers", () => {
    const command = "git status && npm run build";
    const decision = checkPermission(
      "ask",
      req("bash", { command }, "exec"),
      ctx,
      ["bash(git *)"], // allow
      ["bash(sudo *)"], // deny
      ["bash(npm publish *)"], // ask
    );
    expect(decision).toBe("ask");
    expect(lexSpy.mock.calls.filter((c) => c[0] === command)).toHaveLength(1);
    // Chained segments are re-rendered from the shared token stream, not re-lexed.
    expect(lexSpy).toHaveBeenCalledTimes(1);
  });

  it("lexes each substitution body once across the danger and hygiene scans", () => {
    const command = "echo $(cat a.txt) | tee out.txt";
    const decision = checkPermission(
      "auto",
      req("bash", { command }, "exec"),
      ctx,
      ["bash(echo *)"],
      ["bash(curl *)"],
      [],
    );
    expect(decision).toBe("allow");
    expect(lexSpy.mock.calls.filter((c) => c[0] === command)).toHaveLength(1);
    expect(lexSpy.mock.calls.filter((c) => c[0] === "cat a.txt")).toHaveLength(1);
    expect(lexSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache across separate checks", () => {
    const command = "git diff";
    for (let k = 0; k < 2; k += 1) {
      expect(checkPermission("auto", req("bash", { command }, "exec"), ctx)).toBe("allow");
    }
    expect(lexSpy.mock.calls.filter((c) => c[0] === command)).toHaveLength(2);
  });
});

describe("permission rule compilation cache", () => {
  it("returns the same compiled array for the same rules array identity", () => {
    const rules = ["bash(git *)", "read_file"];
    const first = compiledRules(rules);
    expect(compiledRules(rules)).toBe(first);
    // Equal content under a new identity is a different cache entry.
    expect(compiledRules(rules.slice())).not.toBe(first);
    expect(compiledRules(rules.slice())).toEqual(first);
  });

  it("compiles each patterned rule once on first use", () => {
    const allow = ["bash(git *)", "read_file"];
    const regExpSpy = vi.spyOn(globalThis, "RegExp");
    try {
      // ask mode is the tier where allow rules are consulted.
      expect(
        checkPermission("ask", req("bash", { command: "git status" }, "exec"), ctx, allow, [], []),
      ).toBe("allow");
      // Only the patterned rule builds a RegExp; the bare tool rule does not.
      expect(regExpSpy).toHaveBeenCalledTimes(1);
    } finally {
      regExpSpy.mockRestore();
    }
  });

  it("never recompiles while the config arrays are unchanged", () => {
    const allow = ["bash(git *)", "read_file(src/*)"];
    const deny = ["bash(curl *)"];
    const ask = ["bash(git push *)"];
    const check = (command: string) =>
      checkPermission("ask", req("bash", { command }, "exec"), ctx, allow, deny, ask);
    check("git status"); // warm the cache (ask mode consults all three tiers)
    const regExpSpy = vi.spyOn(globalThis, "RegExp");
    try {
      expect(check("git status")).toBe("allow");
      expect(check("git diff HEAD")).toBe("allow");
      expect(check("curl example.com")).toBe("deny");
      expect(check("git push origin main")).toBe("ask");
      expect(regExpSpy).not.toHaveBeenCalled();
    } finally {
      regExpSpy.mockRestore();
    }
  });
});

describe("resolveRealPath TTL cache", () => {
  let sandbox: string;
  let cwdReal: string;
  let fileCtx: PermissionContext;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "star-perm-perf-"));
    cwdReal = path.join(sandbox, "cwd");
    fs.mkdirSync(path.join(cwdReal, "sub"), { recursive: true });
    fileCtx = { cwd: cwdReal };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("serves repeat checks of the same path without new realpathSync calls", () => {
    const spy = vi.spyOn(fs, "realpathSync");
    const check = () =>
      checkPermission("auto", req("write_file", { path: "sub/new.txt" }, "write"), fileCtx);
    expect(check()).toBe("allow");
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    spy.mockClear();
    expect(check()).toBe("allow");
    // Target resolution and the cwd realpath are both cached.
    expect(spy).not.toHaveBeenCalled();
  });

  it("caches negative results for missing paths", () => {
    const spy = vi.spyOn(fs, "realpathSync");
    const check = () =>
      checkPermission("auto", req("write_file", { path: "missing/deep/x.txt" }, "write"), fileCtx);
    expect(check()).toBe("allow");
    const missingCalls = spy.mock.calls.filter((c) => String(c[0]).includes("missing"));
    expect(missingCalls.length).toBeGreaterThan(0);
    spy.mockClear();
    expect(check()).toBe("allow");
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-resolves after the TTL expires", () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const spy = vi.spyOn(fs, "realpathSync");
      const check = () =>
        checkPermission("auto", req("write_file", { path: "sub/new.txt" }, "write"), fileCtx);
      expect(check()).toBe("allow");
      spy.mockClear();
      vi.advanceTimersByTime(6_000);
      expect(Date.now() - start).toBeGreaterThanOrEqual(6_000);
      expect(check()).toBe("allow");
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the symlink-escape denial through the cache", () => {
    const outsideDir = path.join(sandbox, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(
      outsideDir,
      path.join(cwdReal, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const check = () =>
      checkPermission("auto", req("write_file", { path: "escape/evil.txt" }, "write"), fileCtx);
    expect(check()).toBe("deny");
    expect(check()).toBe("deny");
  });
});

describe("win32 UNC fast path", () => {
  it.runIf(process.platform === "win32")(
    "makes a single realpath attempt for an unreachable UNC path and still judges it outside cwd",
    () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "star-perm-unc-"));
      const cwdReal = path.join(sandbox, "cwd");
      fs.mkdirSync(cwdReal, { recursive: true });
      try {
        const original = fs.realpathSync;
        const spy = vi.spyOn(fs, "realpathSync").mockImplementation(((
          p: fs.PathLike,
          ...rest: unknown[]
        ) => {
          if (String(p).startsWith("\\\\")) {
            const err = new Error(`ENOENT: ${String(p)}`) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return (original as (...args: unknown[]) => unknown)(p, ...rest);
        }) as typeof fs.realpathSync);
        const unc = "\\\\star-perm-test-unreachable\\share\\deep\\file.txt";
        const check = () =>
          checkPermission("auto", req("read_file", { path: unc }, "read"), { cwd: cwdReal });
        expect(check()).toBe("deny");
        expect(check()).toBe("deny");
        // One attempt for the whole UNC path (no per-component walk), and the
        // second check is served from the resolution cache.
        const uncCalls = spy.mock.calls.filter((c) => String(c[0]).startsWith("\\\\"));
        expect(uncCalls).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
});
