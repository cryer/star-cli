import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageRequiresPrintError,
  installStdoutEpipeGuard,
  interactiveRequiresTtyError,
  reportResumeSessions,
} from "../src/cli/startup";
import { SessionStore } from "../src/session/store";
import { rmWithRetry } from "./test-fs";

describe("package engines", () => {
  it("requires a node version with AbortSignal.any (>=20.3)", () => {
    // fetch/compaction and others call AbortSignal.any, which only exists on
    // node 20.3+; advertising plain >=20 would crash on 20.0-20.2 at runtime.
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    expect(pkg.engines.node).toBe(">=20.3");
  });
});

describe("startup guards", () => {
  it("rejects --image without print mode", () => {
    expect(imageRequiresPrintError(undefined, ["x.png"])).toBe("--image requires -p/--print");
    expect(imageRequiresPrintError(undefined, ["a.png", "b.png"])).toBe(
      "--image requires -p/--print",
    );
    expect(imageRequiresPrintError("hi", ["x.png"])).toBeNull();
    expect(imageRequiresPrintError(undefined, [])).toBeNull();
  });

  it("requires a TTY on stdin and stdout for interactive mode", () => {
    expect(interactiveRequiresTtyError({ stdinTTY: true, stdoutTTY: true })).toBeNull();
    expect(interactiveRequiresTtyError({ stdinTTY: false, stdoutTTY: true })).toBe(
      "interactive mode requires a TTY; use -p/--print",
    );
    expect(interactiveRequiresTtyError({ stdinTTY: true, stdoutTTY: false })).toBe(
      "interactive mode requires a TTY; use -p/--print",
    );
    expect(interactiveRequiresTtyError({ stdinTTY: false, stdoutTTY: false })).toBe(
      "interactive mode requires a TTY; use -p/--print",
    );
  });

  it("exits quietly on EPIPE and rethrows other stdout errors", () => {
    const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
    installStdoutEpipeGuard(stdout);
    const exits: (string | number | null | undefined)[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      exits.push(code);
    }) as (code?: string | number | null) => never);
    try {
      // star -p "..." | head -1: the downstream close must not surface as a
      // raw EPIPE stack; the process just exits 0.
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      expect(() => stdout.emit("error", epipe)).not.toThrow();
      expect(exits).toEqual([0]);

      const other = Object.assign(new Error("boom"), { code: "EIO" });
      expect(() => stdout.emit("error", other)).toThrow("boom");
      expect(exits).toEqual([0]);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("reportResumeSessions", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-cli-entry-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmWithRetry(home);
  });

  it("returns 1 when the directory has no sessions so scripts can tell failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reportResumeSessions("/work/here")).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("No sessions found for this directory.");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 0 and prints the entries when sessions exist", async () => {
    const store = await SessionStore.create("/work/here", "m");
    await store.append({ role: "user", content: "hi" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await reportResumeSessions("/work/here")).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 messages"));
    } finally {
      logSpy.mockRestore();
    }
  });
});
