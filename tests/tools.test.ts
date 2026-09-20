import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/tools";
import type { ToolContext, ToolResult } from "../src/tools/types";

let dir: string;
let ctx: ToolContext;
const registry = createDefaultRegistry();

function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`tool not registered: ${name}`);
  }
  return tool.execute(args, ctx);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "star-tools-"));
  ctx = { cwd: dir };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("registry", () => {
  it("registers all built-in tools", () => {
    expect(registry.names().sort()).toEqual([
      "bash",
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "task_kill",
      "task_list",
      "task_output",
      "todo_read",
      "todo_write",
      "web_fetch",
      "web_search",
      "write_file",
    ]);
  });
});

describe("read_file", () => {
  it("outputs lines with line numbers", async () => {
    await writeFile(path.join(dir, "a.txt"), "alpha\nbeta\ngamma");
    const res = await run("read_file", { path: "a.txt" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  it("respects offset and limit", async () => {
    const res = await run("read_file", { path: "a.txt", offset: 2, limit: 1 });
    expect(res.content).toContain("2\tbeta");
    expect(res.content).not.toContain("1\talpha");
    expect(res.content).not.toContain("3\tgamma");
  });

  it("truncates files over the default limit and notes it", async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`);
    await writeFile(path.join(dir, "big.txt"), lines.join("\n"));
    const res = await run("read_file", { path: "big.txt" });
    expect(res.content).toContain("2000\tline-2000");
    expect(res.content).not.toContain("2001\t");
    expect(res.content).toContain("truncated");
    expect(res.content).toContain("2100");
  });

  it("refuses sensitive files but allows .env.example", async () => {
    await writeFile(path.join(dir, ".env"), "SECRET=1");
    await writeFile(path.join(dir, ".env.local"), "SECRET=2");
    await writeFile(path.join(dir, ".env.example"), "SECRET=");
    await writeFile(path.join(dir, "server.pem"), "KEY");
    for (const p of [".env", ".env.local", "server.pem"]) {
      const res = await run("read_file", { path: p });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("sensitive");
    }
    const ok = await run("read_file", { path: ".env.example" });
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toBe("1\tSECRET=");
  });

  it("errors on directory paths and missing files", async () => {
    const res = await run("read_file", { path: "." });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("directory");
    const missing = await run("read_file", { path: "nope.txt" });
    expect(missing.isError).toBe(true);
  });
});

describe("write_file", () => {
  it("creates parent directories and writes content", async () => {
    const res = await run("write_file", { path: "sub/dir/out.txt", content: "hello" });
    expect(res.isError).toBeUndefined();
    expect(await readFile(path.join(dir, "sub/dir/out.txt"), "utf8")).toBe("hello");
  });
});

describe("edit_file", () => {
  it("replaces a unique match", async () => {
    await writeFile(path.join(dir, "e.txt"), "foo bar baz");
    const res = await run("edit_file", { path: "e.txt", old_string: "bar", new_string: "qux" });
    expect(res.isError).toBeUndefined();
    expect(await readFile(path.join(dir, "e.txt"), "utf8")).toBe("foo qux baz");
  });

  it("fails when old_string matches multiple locations", async () => {
    await writeFile(path.join(dir, "e2.txt"), "dup dup");
    const res = await run("edit_file", { path: "e2.txt", old_string: "dup", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("2");
  });

  it("replace_all replaces every occurrence", async () => {
    const res = await run("edit_file", {
      path: "e2.txt",
      old_string: "dup",
      new_string: "x",
      replace_all: true,
    });
    expect(res.isError).toBeUndefined();
    expect(await readFile(path.join(dir, "e2.txt"), "utf8")).toBe("x x");
  });

  it("fails when old_string is not found", async () => {
    const res = await run("edit_file", { path: "e2.txt", old_string: "missing", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });
});

describe("glob", () => {
  beforeAll(async () => {
    await mkdir(path.join(dir, "src/deep"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(dir, "src/a.ts"), "");
    await writeFile(path.join(dir, "src/deep/b.ts"), "");
    await writeFile(path.join(dir, "src/c.txt"), "");
    await writeFile(path.join(dir, "node_modules/pkg/dep.ts"), "");
  });

  it("bare pattern matches basenames recursively and skips node_modules", async () => {
    const res = await run("glob", { pattern: "*.ts" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/deep/b.ts");
    expect(res.content).not.toContain("c.txt");
    expect(res.content).not.toContain("node_modules");
  });

  it("anchored ** pattern matches nested paths", async () => {
    const res = await run("glob", { pattern: "src/**/*.ts" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/deep/b.ts");
    expect(res.content).not.toContain("c.txt");
  });

  it("supports ? wildcard and reports no matches", async () => {
    const res = await run("glob", { pattern: "src/?.txt" });
    expect(res.content).toContain("src/c.txt");
    const none = await run("glob", { pattern: "*.xyz" });
    expect(none.content).toContain("No files matched");
  });
});

describe("grep", () => {
  beforeAll(async () => {
    await writeFile(path.join(dir, "g.txt"), "hello world\nfoo\nhello again");
    await writeFile(path.join(dir, "g.md"), "hello markdown");
  });

  it("outputs file:line:content matches", async () => {
    const res = await run("grep", { pattern: "hello" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("g.txt:1:hello world");
    expect(res.content).toContain("g.txt:3:hello again");
    expect(res.content).not.toContain("g.txt:2:foo");
  });

  it("filters by glob and supports ignoreCase", async () => {
    const res = await run("grep", { pattern: "hello", glob: "*.md" });
    expect(res.content).toContain("g.md:1:hello markdown");
    expect(res.content).not.toContain("g.txt");
    const ci = await run("grep", { pattern: "HELLO", glob: "g.txt", ignoreCase: true });
    expect(ci.content).toContain("g.txt:1:hello world");
  });

  it("skips binary files and reports invalid regex", async () => {
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([104, 101, 108, 108, 111, 0, 119]));
    const res = await run("grep", { pattern: "hello", glob: "*.dat" });
    expect(res.content).toContain("No matches");
    const bad = await run("grep", { pattern: "([" });
    expect(bad.isError).toBe(true);
  });
});

describe("bash", () => {
  it("captures stdout of a successful command", async () => {
    const res = await run("bash", { command: "echo hello-star" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("hello-star");
  });

  it("appends exit code on failure", async () => {
    const res = await run("bash", {
      command: "node -e \"console.error('oops'); process.exit(3)\"",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("oops");
    expect(res.content).toContain("Exit code: 3");
  });

  it("times out long-running commands", async () => {
    const res = await run("bash", {
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeout: 1,
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timed out");
  }, 15000);
});
