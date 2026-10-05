import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskManager, type TaskSnapshot, defaultTaskManager } from "../src/tasks/manager";
import { bashTool, decodeOutput, trimUtf8End, trimUtf8Start } from "../src/tools/bash";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "star-decode-test-"));
});

afterEach(() => {
  defaultTaskManager.cleanup();
  rmSync(cwd, { recursive: true, force: true });
});

function waitForTerminal(
  manager: TaskManager,
  id: string,
  timeoutMs = 10000,
): Promise<TaskSnapshot> {
  const existing = manager.get(id);
  if (existing && existing.status !== "running") {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("update", onUpdate);
      reject(new Error(`timed out waiting for ${id} to finish`));
    }, timeoutMs);
    const onUpdate = (task: TaskSnapshot) => {
      if (task.id === id && task.status !== "running") {
        clearTimeout(timer);
        manager.off("update", onUpdate);
        resolve(task);
      }
    };
    manager.on("update", onUpdate);
  });
}

// "中" is E4 B8 AD in UTF-8: writing the lead byte and the continuation
// bytes in separate flushes splits the character across output chunks.
const SPLIT_CHAR_COMMAND =
  'node -e "process.stdout.write(Buffer.from([0xE4])); setTimeout(() => process.stdout.write(Buffer.from([0xB8, 0xAD])), 200)"';

describe("chunk-boundary decoding", () => {
  it("foreground bash keeps a multi-byte character split across chunks intact", async () => {
    const res = await bashTool.execute({ command: SPLIT_CHAR_COMMAND }, { cwd });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("中");
    expect(res.content).not.toContain("�");
  }, 15000);

  it("background task output keeps a split multi-byte character intact", async () => {
    const manager = new TaskManager();
    const started = manager.start({ command: SPLIT_CHAR_COMMAND, cwd });
    const finished = await waitForTerminal(manager, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.output).toContain("中");
    expect(finished.output).not.toContain("�");
  }, 15000);

  it("truncated CJK output has no replacement characters at the head/tail seam", async () => {
    // 1 ASCII byte + 11000 CJK chars = 33001 bytes > 30KB cap, and byte
    // 15000 (the seam) lands inside a character.
    const res = await bashTool.execute(
      { command: "node -e \"process.stdout.write('x' + '中'.repeat(11000))\"" },
      { cwd },
    );
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("bytes truncated");
    expect(res.content).not.toContain("�");
    expect(res.content.startsWith(`x${"中".repeat(10)}`)).toBe(true);
    expect(res.content.endsWith("中".repeat(10))).toBe(true);
  }, 15000);
});

describe("decodeOutput", () => {
  it("decodes valid UTF-8 on every platform", () => {
    const buf = Buffer.from("hello 中文", "utf8");
    expect(decodeOutput(buf, "win32")).toBe("hello 中文");
    expect(decodeOutput(buf, "linux")).toBe("hello 中文");
  });

  it("re-decodes OEM-codepage (GBK) bytes on win32", () => {
    // "中文" in GBK.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeOutput(gbk, "win32")).toBe("中文");
  });

  it("leaves undecodable bytes as U+FFFD off win32", () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeOutput(gbk, "linux")).toContain("�");
  });
});

describe("utf8 seam trimming", () => {
  it("drops a trailing incomplete sequence", () => {
    expect(trimUtf8End(Buffer.from([0x61, 0xe4, 0xb8]))).toEqual(Buffer.from([0x61]));
  });

  it("keeps a trailing complete sequence", () => {
    const buf = Buffer.from([0x61, 0xe4, 0xb8, 0xad]);
    expect(trimUtf8End(buf)).toEqual(buf);
  });

  it("drops leading continuation bytes", () => {
    expect(trimUtf8Start(Buffer.from([0xb8, 0xad, 0x61]))).toEqual(Buffer.from([0x61]));
  });

  it("keeps a buffer starting on a character boundary", () => {
    const buf = Buffer.from([0xe4, 0xb8, 0xad]);
    expect(trimUtf8Start(buf)).toEqual(buf);
  });
});
