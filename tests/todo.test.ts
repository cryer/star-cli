import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TodoStore, createDefaultRegistry, createTodoTools } from "../src/tools";
import type { TodoItem } from "../src/tools";
import { parseTodoArgs, pendingTodoTitles } from "../src/tools/todo";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types";

let dir: string;
let ctx: ToolContext;
let store: TodoStore;
let tools: Tool[];

const sample: TodoItem[] = [
  { id: 1, title: "write docs", status: "pending" },
  { id: 2, title: "fix bug", status: "in_progress" },
  { id: 3, title: "ship it", status: "done" },
];

function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool.execute(args, ctx);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "star-todo-"));
  ctx = { cwd: dir };
  store = new TodoStore();
  tools = createTodoTools(store);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("todo_write / todo_read", () => {
  it("writes and reads back the same list", async () => {
    const res = await run("todo_write", { todos: sample });
    expect(res.isError).toBeUndefined();
    expect(store.list()).toEqual(sample);
    const read = await run("todo_read", {});
    expect(read.content).toContain("write docs");
    expect(read.content).toContain("fix bug");
    expect(read.content).toContain("ship it");
  });

  it("replaces the whole list on each write", async () => {
    const next: TodoItem[] = [{ id: 9, title: "only item", status: "pending" }];
    await run("todo_write", { todos: next });
    expect(store.list()).toEqual(next);
    const read = await run("todo_read", {});
    expect(read.content).toContain("only item");
    expect(read.content).not.toContain("write docs");
  });

  it("persists to .star/todos.json and a fresh store loads it", async () => {
    const raw = await readFile(path.join(dir, ".star", "todos.json"), "utf8");
    expect(JSON.parse(raw)).toEqual([{ id: 9, title: "only item", status: "pending" }]);

    const fresh = new TodoStore();
    const freshTools = createTodoTools(fresh);
    const readTool = freshTools.find((t) => t.name === "todo_read");
    const res = await readTool?.execute({}, ctx);
    expect(res?.content).toContain("only item");
  });

  it("returns No todos. for an empty list", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "star-todo-empty-"));
    const emptyStore = new TodoStore();
    const emptyTools = createTodoTools(emptyStore);
    const readTool = emptyTools.find((t) => t.name === "todo_read");
    const res = await readTool?.execute({}, { cwd: emptyDir });
    expect(res?.content).toBe("No todos.");
    await rm(emptyDir, { recursive: true, force: true });
  });

  it("rejects an invalid status", async () => {
    const res = await run("todo_write", { todos: [{ id: 1, title: "x", status: "bogus" }] });
    expect(res.isError).toBe(true);
  });

  it("formats output with status symbols", async () => {
    const res = await run("todo_write", { todos: sample });
    expect(res.content).toContain("[ ] 1. write docs");
    expect(res.content).toContain("[~] 2. fix bug");
    expect(res.content).toContain("(in_progress)");
    expect(res.content).toContain("[x] 3. ship it");
    expect(res.content).toContain("(done)");
  });
});

describe("registry", () => {
  it("includes todo_write and todo_read", () => {
    const registry = createDefaultRegistry();
    expect(registry.names()).toContain("todo_write");
    expect(registry.names()).toContain("todo_read");
  });
});

describe("parseTodoArgs / pendingTodoTitles", () => {
  it("parses a valid todo_write payload", () => {
    expect(parseTodoArgs({ todos: sample })).toEqual(sample);
    expect(pendingTodoTitles({ todos: sample })).toEqual(["write docs", "fix bug"]);
  });

  it("rejects malformed payloads", () => {
    expect(parseTodoArgs({ todos: [{ id: "x" }] })).toBeNull();
    expect(parseTodoArgs(null)).toBeNull();
    expect(pendingTodoTitles(undefined)).toEqual([]);
  });
});
