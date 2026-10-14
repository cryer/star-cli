import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvFileKeys, loadEnvFile } from "../src/config/env";
import { type TaskSnapshot, defaultTaskManager } from "../src/tasks/manager";
import { bashTool, childEnv } from "../src/tools/bash";

const KEY = "STAR_TEST_FAKE_PROVIDER_KEY";
const VALUE = "super-secret-value-12345";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-bash-env-"));
  delete process.env[KEY];
  writeFileSync(path.join(dir, ".env"), `${KEY}=${VALUE}\n`);
  loadEnvFile(path.join(dir, ".env"));
});

afterEach(() => {
  defaultTaskManager.cleanup();
  delete process.env[KEY];
  rmSync(dir, { recursive: true, force: true });
});

function waitForTerminal(id: string, timeoutMs = 10000): Promise<TaskSnapshot> {
  const existing = defaultTaskManager.get(id);
  if (existing && existing.status !== "running") {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      defaultTaskManager.off("update", onUpdate);
      reject(new Error(`timed out waiting for ${id} to finish`));
    }, timeoutMs);
    const onUpdate = (task: TaskSnapshot) => {
      if (task.id === id && task.status !== "running") {
        clearTimeout(timer);
        defaultTaskManager.off("update", onUpdate);
        resolve(task);
      }
    };
    defaultTaskManager.on("update", onUpdate);
  });
}

describe("bash child env scrubbing", () => {
  it("loadEnvFile records the parsed keys and fills process.env", () => {
    expect(getEnvFileKeys().has(KEY)).toBe(true);
    expect(process.env[KEY]).toBe(VALUE);
  });

  it("childEnv drops .env keys but keeps the rest of the environment", () => {
    const env = childEnv();
    expect(env[KEY]).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    // The main process itself is unaffected.
    expect(process.env[KEY]).toBe(VALUE);
  });

  it("foreground bash children cannot read the .env key", async () => {
    const res = await bashTool.execute(
      { command: `node -e "console.log(process.env.${KEY} ?? 'UNSET')"` },
      { cwd: dir },
    );
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("UNSET");
    expect(res.content).not.toContain(VALUE);
    expect(process.env[KEY]).toBe(VALUE);
  }, 15000);

  it("background task children cannot read the .env key", async () => {
    const res = await bashTool.execute(
      {
        command: `node -e "console.log(process.env.${KEY} ?? 'UNSET')"`,
        run_in_background: true,
      },
      { cwd: dir },
    );
    const id = res.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    const finished = await waitForTerminal(id);
    expect(finished.status).toBe("completed");
    expect(finished.output).toContain("UNSET");
    expect(finished.output).not.toContain(VALUE);
  }, 15000);
});

describe("childEnv MSYS path conversion", () => {
  const MSYS_KEYS = ["MSYS_NO_PATHCONV", "MSYS2_ARG_CONV_EXCL"] as const;
  const saved = MSYS_KEYS.map((k) => process.env[k]);

  beforeEach(() => {
    for (const k of MSYS_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [i, k] of MSYS_KEYS.entries()) {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    }
  });

  it("disables MSYS path conversion for win32 children", () => {
    expect(childEnv("win32").MSYS_NO_PATHCONV).toBe("1");
  });

  it("leaves other platforms untouched", () => {
    expect(childEnv("linux").MSYS_NO_PATHCONV).toBeUndefined();
  });

  it("respects a user-configured conversion setting", () => {
    process.env.MSYS_NO_PATHCONV = "0";
    expect(childEnv("win32").MSYS_NO_PATHCONV).toBe("0");
    for (const k of MSYS_KEYS) delete process.env[k];
    process.env.MSYS2_ARG_CONV_EXCL = "/ipconfig";
    expect(childEnv("win32").MSYS_NO_PATHCONV).toBeUndefined();
  });

  const itWin = process.platform === "win32" ? it : it.skip;
  itWin(
    "bash children receive MSYS_NO_PATHCONV=1 on Windows",
    async () => {
      const res = await bashTool.execute(
        { command: `node -e "console.log(process.env.MSYS_NO_PATHCONV ?? 'UNSET')"` },
        { cwd: dir },
      );
      expect(res.isError).toBeUndefined();
      expect(res.content.trim()).toBe("1");
    },
    15000,
  );
});
