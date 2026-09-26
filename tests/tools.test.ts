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

  it("refuses the extended sensitive list from core", async () => {
    await writeFile(path.join(dir, ".npmrc"), "//registry");
    await writeFile(path.join(dir, "id_ed25519"), "KEY");
    await mkdir(path.join(dir, ".aws"), { recursive: true });
    await writeFile(path.join(dir, ".aws", "credentials"), "[default]");
    await writeFile(path.join(dir, "cert.key"), "KEY");
    for (const p of [".npmrc", "id_ed25519", ".aws/credentials", "cert.key"]) {
      const res = await run("read_file", { path: p });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("sensitive");
    }
  });

  it("errors on directory paths and missing files", async () => {
    const res = await run("read_file", { path: "." });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("directory");
    const missing = await run("read_file", { path: "nope.txt" });
    expect(missing.isError).toBe(true);
  });

  it("strips trailing carriage returns from CRLF files", async () => {
    await writeFile(path.join(dir, "crlf.txt"), "one\r\ntwo\r\nthree");
    const res = await run("read_file", { path: "crlf.txt" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("1\tone\n2\ttwo\n3\tthree");
  });

  it("refuses binary files", async () => {
    await writeFile(path.join(dir, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    const res = await run("read_file", { path: "bin.dat" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("binary");
  });

  it("reads UTF-16 files with a BOM as text instead of flagging them binary", async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\nbeta", "utf16le")]);
    await writeFile(path.join(dir, "u16le.txt"), le);
    const resLe = await run("read_file", { path: "u16le.txt" });
    expect(resLe.isError).toBeUndefined();
    expect(resLe.content).toBe("1\talpha\n2\tbeta");

    const beBody = Buffer.from("alpha\nbeta", "utf16le");
    for (let i = 0; i + 1 < beBody.length; i += 2) {
      const b0 = beBody[i] ?? 0;
      beBody[i] = beBody[i + 1] ?? 0;
      beBody[i + 1] = b0;
    }
    await writeFile(
      path.join(dir, "u16be.txt"),
      Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]),
    );
    const resBe = await run("read_file", { path: "u16be.txt" });
    expect(resBe.isError).toBeUndefined();
    expect(resBe.content).toBe("1\talpha\n2\tbeta");
  });

  it("reports a clear message when offset is beyond end of file", async () => {
    const res = await run("read_file", { path: "a.txt", offset: 99 });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("(offset 99 beyond end of file; file has 3 lines)");
  });

  it("reads only the first 1MB of very large files and notes the cap", async () => {
    const big = `${"x".repeat(100)}\n`.repeat(11000);
    await writeFile(path.join(dir, "huge.txt"), big);
    const res = await run("read_file", { path: "huge.txt" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("truncated");
    expect(res.content).toContain("at least");
    const pastCap = await run("read_file", { path: "huge.txt", offset: 10_000_000 });
    expect(pastCap.content).toContain("offset 10000000 beyond end of file");
    expect(pastCap.content).toContain("at least");
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

  it("treats $ sequences in new_string literally", async () => {
    await writeFile(path.join(dir, "dollar.txt"), "a=1");
    const replacement = String.raw`sed 's/$&/$$1/g' $1`;
    const res = await run("edit_file", {
      path: "dollar.txt",
      old_string: "a=1",
      new_string: replacement,
    });
    expect(res.isError).toBeUndefined();
    expect(await readFile(path.join(dir, "dollar.txt"), "utf8")).toBe(replacement);
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

  it("expands {a,b} braces, including one nested level", async () => {
    const res = await run("glob", { pattern: "src/*.{ts,txt}" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/c.txt");
    expect(res.content).not.toContain("deep");
    const nested = await run("glob", { pattern: "src/{deep/*.ts,*.{ts,txt}}" });
    expect(nested.content).toContain("src/deep/b.ts");
    expect(nested.content).toContain("src/a.ts");
    expect(nested.content).toContain("src/c.txt");
  });

  it("supports character classes and negated classes", async () => {
    await writeFile(path.join(dir, "src/b.ts"), "");
    const res = await run("glob", { pattern: "src/[ab].ts" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).toContain("src/b.ts");
    expect(res.content).not.toContain("deep");
    const neg = await run("glob", { pattern: "src/[!a].ts" });
    expect(neg.content).toContain("src/b.ts");
    expect(neg.content).not.toContain("src/a.ts");
  });

  it("collapses consecutive **/ segments without changing semantics", async () => {
    const res = await run("glob", { pattern: "src/**/**/deep/*.ts" });
    expect(res.content).toContain("src/deep/b.ts");
  });

  it("drills into literal directory prefixes and still reports prefixed paths", async () => {
    const res = await run("glob", { pattern: "src/deep/*.ts" });
    expect(res.content).toBe("src/deep/b.ts");
    const missing = await run("glob", { pattern: "no-such-dir/deeper/*.ts" });
    expect(missing.content).toContain("No files matched");
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

  it("refuses an explicitly named sensitive file and filters sensitive files from walks", async () => {
    await writeFile(path.join(dir, ".env"), "GREPSECRET=1");
    const refused = await run("grep", { pattern: "GREPSECRET", path: ".env" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("sensitive");
    const walked = await run("grep", { pattern: "GREPSECRET" });
    expect(walked.content).toContain("No matches");
  });

  it("truncates long matching lines to 500 characters", async () => {
    await writeFile(path.join(dir, "longline.txt"), `prefix ${"a".repeat(1000)} suffix`);
    const res = await run("grep", { pattern: "prefix", path: "longline.txt" });
    const line = res.content.split("\n")[0] ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThanOrEqual("longline.txt:1:".length + 501);
  });

  it("rejects overly complex patterns before they can hang", async () => {
    const long = await run("grep", { pattern: "a".repeat(201) });
    expect(long.isError).toBe(true);
    expect(long.content).toContain("pattern too complex");
    const nested = await run("grep", { pattern: "(a+)+" });
    expect(nested.isError).toBe(true);
    expect(nested.content).toContain("pattern too complex");
    const ranged = await run("grep", { pattern: "(foo|bar){2,4}" });
    expect(ranged.isError).toBe(true);
  });

  it("skips files over 5MB and notes them", async () => {
    await writeFile(path.join(dir, "huge-grep.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const res = await run("grep", { pattern: "aaaa", glob: "huge-grep.txt" });
    expect(res.content).toContain("No matches");
    expect(res.content).toContain("skipped 1 file(s) larger than 5MB");
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

  it("bounds very large output with a truncation marker", async () => {
    const res = await run("bash", {
      command: `node -e "process.stdout.write('a'.repeat(100) + '\\n' + 'b'.repeat(100000) + '\\n' + 'c'.repeat(100))"`,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("characters truncated");
    expect(res.content.length).toBeLessThanOrEqual(30000 + 100);
    expect(res.content.startsWith("a".repeat(100))).toBe(true);
    expect(res.content.endsWith("c".repeat(100))).toBe(true);
  }, 15000);
});
