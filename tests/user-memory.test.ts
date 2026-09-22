import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  USER_MEMORY_MAX_CHARS,
  appendUserMemory,
  createRememberTool,
  readUserMemory,
} from "../src/agent/user-memory";

describe("user memory", () => {
  let home: string;
  let memoryFile: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "star-user-memory-"));
    memoryFile = path.join(home, "MEMORY.md");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("readUserMemory", () => {
    it("returns null when the file is missing", () => {
      expect(readUserMemory(home)).toBeNull();
    });

    it("returns null when the file is empty or whitespace-only", () => {
      writeFileSync(memoryFile, "", "utf8");
      expect(readUserMemory(home)).toBeNull();
      writeFileSync(memoryFile, "  \n", "utf8");
      utimesSync(memoryFile, new Date(), new Date());
      expect(readUserMemory(home)).toBeNull();
    });

    it("returns the header block with the body", () => {
      writeFileSync(memoryFile, "- prefers pnpm\n- uses vim\n", "utf8");
      const block = readUserMemory(home);
      expect(block).toContain("# User memory (MEMORY.md)");
      expect(block).toContain("notes were saved by the user across sessions");
      expect(block).toContain("- prefers pnpm");
      expect(block).toContain("- uses vim");
    });

    it("re-reads when the mtime changes", () => {
      writeFileSync(memoryFile, "first", "utf8");
      expect(readUserMemory(home)).toContain("first");
      expect(readUserMemory(home)).not.toContain("second");

      writeFileSync(memoryFile, "second", "utf8");
      const later = new Date(Date.now() + 10_000);
      utimesSync(memoryFile, later, later);
      const block = readUserMemory(home);
      expect(block).toContain("second");
      expect(block).not.toContain("first");
    });

    it("truncates bodies past the cap", () => {
      writeFileSync(memoryFile, "x".repeat(USER_MEMORY_MAX_CHARS + 100), "utf8");
      const block = readUserMemory(home);
      expect(block).toContain(`[MEMORY.md truncated to ${USER_MEMORY_MAX_CHARS} characters]`);
      expect(block?.length).toBeLessThan(USER_MEMORY_MAX_CHARS + 300);
    });
  });

  describe("appendUserMemory", () => {
    it("creates the file (and home directory) when missing", () => {
      const nested = path.join(home, "new-home");
      appendUserMemory("likes cats", nested);
      expect(readFileSync(path.join(nested, "MEMORY.md"), "utf8")).toBe("- likes cats\n");
    });

    it("appends bullet lines", () => {
      appendUserMemory("first note", home);
      appendUserMemory("second note", home);
      expect(readFileSync(memoryFile, "utf8")).toBe("- first note\n- second note\n");
    });

    it("is reflected by a subsequent readUserMemory", () => {
      appendUserMemory("remembers this", home);
      expect(readUserMemory(home)).toContain("- remembers this");
    });
  });

  describe("remember tool", () => {
    it("appends to memory and returns a confirmation", async () => {
      const tool = createRememberTool({ home });
      const result = await tool.execute({ text: "user prefers dark mode" }, { cwd: home });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("user prefers dark mode");
      expect(readFileSync(memoryFile, "utf8")).toBe("- user prefers dark mode\n");
    });

    it("has write-level permission", () => {
      expect(createRememberTool({ home }).permission).toBe("write");
    });

    it("rejects notes over the max length", () => {
      const tool = createRememberTool({ home });
      const parsed = tool.parameters.safeParse({ text: "x".repeat(501) });
      expect(parsed.success).toBe(false);
    });
  });
});
