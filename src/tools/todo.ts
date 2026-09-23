import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "./types";

export interface TodoItem {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done";
}

const todoItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done"]),
});

const writeSchema = z.object({
  todos: z.array(todoItemSchema).describe("The full todo list, replacing the current one"),
});

const readSchema = z.object({});

function fileFor(cwd: string): string {
  return path.join(cwd, ".star", "todos.json");
}

export class TodoStore {
  private items = new Map<number, TodoItem>();

  list(): TodoItem[] {
    return [...this.items.values()];
  }

  replace(items: TodoItem[]): void {
    this.items.clear();
    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  async load(cwd: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(fileFor(cwd), "utf8");
    } catch {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.replace(parsed.filter((it) => todoItemSchema.safeParse(it).success));
      }
    } catch {
      // corrupted file: keep current state
    }
  }

  async save(cwd: string): Promise<void> {
    await mkdir(path.join(cwd, ".star"), { recursive: true });
    await writeFile(fileFor(cwd), `${JSON.stringify(this.list(), null, 2)}\n`);
  }
}

const SYMBOLS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) {
    return "No todos.";
  }
  const lines = items.map((it) => `${SYMBOLS[it.status]} ${it.id}. ${it.title}`);
  const width = Math.max(...lines.map((l) => l.length));
  return lines
    .map((line, i) => {
      const status = items[i]?.status;
      return status === "pending" ? line : `${line.padEnd(width + 4)}(${status})`;
    })
    .join("\n");
}

const defaultStore = new TodoStore();

// Full parsed list from a todo_write args payload, or null when malformed.
// The REPL uses this to mirror the todo list next to the input box.
export function parseTodoArgs(args: unknown): TodoItem[] | null {
  const parsed = writeSchema.safeParse(args);
  return parsed.success ? parsed.data.todos : null;
}

// Titles of unfinished items from a todo_write args payload; [] when the
// payload is malformed. Used by the agent loop to spot turns that end while
// the model's own todo list still has open work.
export function pendingTodoTitles(args: unknown): string[] {
  return (parseTodoArgs(args) ?? []).filter((t) => t.status !== "done").map((t) => t.title);
}

// Load the persisted todo list for a cwd into the default store and return
// it — used by the REPL to show todos that predate the current session.
export async function loadTodos(cwd: string): Promise<TodoItem[]> {
  await defaultStore.load(cwd);
  return defaultStore.list();
}

export function createTodoTools(store: TodoStore = defaultStore): Tool[] {
  const todoWrite: Tool<typeof writeSchema> = {
    name: "todo_write",
    description:
      "Replace the current todo list with the given items. Each item has an id, title, and status (pending, in_progress, done).",
    permission: "read",
    parameters: writeSchema,
    async execute(args, ctx) {
      const parsed = writeSchema.safeParse(args);
      if (!parsed.success) {
        return { content: `Invalid todos: ${parsed.error.message}`, isError: true };
      }
      await store.load(ctx.cwd);
      store.replace(parsed.data.todos);
      await store.save(ctx.cwd);
      return { content: formatTodos(store.list()) };
    },
  };

  const todoRead: Tool<typeof readSchema> = {
    name: "todo_read",
    description: "Read the current todo list.",
    permission: "read",
    parameters: readSchema,
    async execute(_args, ctx) {
      await store.load(ctx.cwd);
      return { content: formatTodos(store.list()) };
    },
  };

  return [todoWrite, todoRead];
}
