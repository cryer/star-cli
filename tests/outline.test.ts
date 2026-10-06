import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/tools";
import type { ToolContext, ToolResult } from "../src/tools/types";

let dir: string;
let ctx: ToolContext;
const registry = createDefaultRegistry();

function run(args: Record<string, unknown>): Promise<ToolResult> {
  const tool = registry.get("code_outline");
  if (!tool) throw new Error("code_outline not registered");
  return tool.execute(args, ctx);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "star-outline-"));
  ctx = { cwd: dir };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const TS_SAMPLE = `import { z } from "zod";

export interface Config {
  name: string;
}

export type Handler = (e: string) => void;

export class Engine {
  private running = false;

  constructor(private name: string) {}

  async start(port: number): Promise<void> {
    if (port > 0) {
      this.running = true;
    }
  }

  stop(): void {
    return;
  }
}

export function createEngine(name: string): Engine {
  return new Engine(name);
}

const helper = (a: number, b: number) => a + b;

function tail() {
  finalize();
}
`;

describe("code_outline file mode", () => {
  it("lists TS declarations with line numbers and nesting, skipping control flow", async () => {
    await writeFile(path.join(dir, "sample.ts"), TS_SAMPLE);
    const res = await run({ path: "sample.ts" });
    expect(res.isError).toBeUndefined();
    const lines = res.content.split("\n");
    expect(lines).toContain("3\texport interface Config {");
    expect(lines).toContain("7\texport type Handler = (e: string) => void;");
    expect(lines).toContain("9\texport class Engine {");
    expect(lines).toContain("12\t  constructor(private name: string) {}");
    expect(lines).toContain("14\t  async start(port: number): Promise<void> {");
    expect(lines).toContain("20\t  stop(): void {");
    expect(lines).toContain("25\texport function createEngine(name: string): Engine {");
    expect(lines).toContain("29\tconst helper = (a: number, b: number) => a + b;");
    // Control flow and bare statements are not declarations.
    expect(res.content).not.toContain("if (port > 0)");
    expect(res.content).not.toContain("this.running");
    expect(res.content).not.toContain("return;");
    // Bare indented calls are not declarations either.
    expect(res.content).not.toContain("finalize()");
    // Local variables at top level without arrow bodies stay out.
    expect(lines.some((l) => l.includes("private running"))).toBe(false);
  });

  it("lists python declarations with nesting", async () => {
    await writeFile(
      path.join(dir, "sample.py"),
      "import os\n\nclass Foo:\n    def bar(self):\n        pass\n\ndef baz(x):\n    return x\n",
    );
    const res = await run({ path: "sample.py" });
    expect(res.content).toBe("3\tclass Foo:\n4\t    def bar(self):\n7\tdef baz(x):");
  });

  it("lists go and rust declarations", async () => {
    await writeFile(
      path.join(dir, "sample.go"),
      "package main\n\ntype Server struct{}\n\nfunc (s *Server) Run() {}\n\nfunc main() {}\n",
    );
    const go = await run({ path: "sample.go" });
    expect(go.content).toContain("3\ttype Server struct{}");
    expect(go.content).toContain("5\tfunc (s *Server) Run() {}");
    expect(go.content).toContain("7\tfunc main() {}");

    await writeFile(
      path.join(dir, "sample.rs"),
      "pub struct Config {}\n\nimpl Config {\n    pub fn new() -> Config {\n        Config {}\n    }\n}\n\nfn main() {}\n",
    );
    const rs = await run({ path: "sample.rs" });
    expect(rs.content).toContain("1\tpub struct Config {}");
    expect(rs.content).toContain("4\t    pub fn new() -> Config {");
    expect(rs.content).toContain("9\tfn main() {}");
  });

  it("reports unsupported extensions", async () => {
    await writeFile(path.join(dir, "notes.txt"), "hello world");
    const res = await run({ path: "notes.txt" });
    expect(res.content).toContain("No supported source language");
  });

  it("reports files with no recognizable declarations", async () => {
    await writeFile(path.join(dir, "plain.ts"), "const x = 1;\nconsole.log(x);\n");
    const res = await run({ path: "plain.ts" });
    expect(res.content).toContain("(no recognizable declarations");
  });

  it("refuses sensitive files", async () => {
    await writeFile(path.join(dir, ".env"), "SECRET=1");
    const res = await run({ path: ".env" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Refused");
  });

  it("errors on missing paths", async () => {
    const res = await run({ path: "does-not-exist.ts" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Path not found");
  });

  it("skips minified bundles", async () => {
    await writeFile(path.join(dir, "vendor.min.js"), "function a(){return 1}");
    const res = await run({ path: "vendor.min.js" });
    expect(res.content).toContain("No supported source language");
  });
});

describe("code_outline directory mode", () => {
  beforeAll(async () => {
    await mkdir(path.join(dir, "proj", "src"), { recursive: true });
    await mkdir(path.join(dir, "proj", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(dir, "proj", "src", "a.ts"), "export function alpha() {}\n");
    await writeFile(path.join(dir, "proj", "src", "b.py"), "def beta():\n    pass\n");
    await writeFile(path.join(dir, "proj", "src", "empty.ts"), "const x = 1;\n");
    await writeFile(path.join(dir, "proj", "README.md"), "# not source\n");
    await writeFile(
      path.join(dir, "proj", "node_modules", "dep", "index.js"),
      "function hidden() {}\n",
    );
  });

  it("outlines source files across a tree, skipping node_modules and non-source", async () => {
    const res = await run({ path: "proj" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("src/a.ts:");
    expect(res.content).toContain("1\texport function alpha() {}");
    expect(res.content).toContain("src/b.py:");
    expect(res.content).toContain("1\tdef beta():");
    expect(res.content).not.toContain("empty.ts");
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain("README");
  });

  it("honors maxFiles", async () => {
    const res = await run({ path: "proj", maxFiles: 1 });
    expect(res.content).toContain("src/a.ts:");
    expect(res.content).not.toContain("src/b.py:");
    expect(res.content).toContain("truncated");
  });

  it("reports trees without declarations", async () => {
    await mkdir(path.join(dir, "bare"), { recursive: true });
    await writeFile(path.join(dir, "bare", "x.ts"), "const y = 2;\n");
    const res = await run({ path: "bare" });
    expect(res.content).toContain("No recognizable declarations");
  });
});
