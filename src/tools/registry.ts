import { bashTool } from "./bash";
import { editFileTool } from "./fs/edit";
import { globTool } from "./fs/glob";
import { grepTool } from "./fs/grep";
import { codeOutlineTool } from "./fs/outline";
import { createReadFileTool } from "./fs/read";
import { readImageTool } from "./fs/read-image";
import { writeFileTool } from "./fs/write";
import { screenshotTool } from "./screenshot";
import { taskKillTool, taskListTool, taskOutputTool } from "./tasks";
import { type TodoStore, createTodoTools } from "./todo";
import type { Tool } from "./types";
import { webFetchTool } from "./web/fetch";
import { webSearchTool } from "./web/search";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  // todoStore defaults to the module-level shared store; subagent loops pass
  // their own instance so a child's todo_write cannot clobber the parent list.
  constructor(todoStore?: TodoStore) {
    for (const tool of [
      // Fresh per registry (i.e. per agent loop): the unchanged-since-last-
      // read cache must not leak across loops, whose contexts differ.
      createReadFileTool(),
      readImageTool,
      screenshotTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      codeOutlineTool,
      bashTool,
      webFetchTool,
      webSearchTool,
      taskListTool,
      taskOutputTool,
      taskKillTool,
      ...createTodoTools(todoStore),
    ]) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  // Drops every tool the predicate rejects. Used to restrict a read-only
  // subagent loop's tool set; the agent loop reads list() lazily per
  // request, so a retain right after loop construction still shapes the
  // first request. The permission gate stays as backstop for anything
  // attempted outside the model's tool map.
  retain(predicate: (tool: Tool) => boolean): void {
    for (const [name, tool] of this.tools) {
      if (!predicate(tool)) this.tools.delete(name);
    }
  }

  // Drops per-session volatile tool state after a wholesale history rewrite
  // (compaction, /undo, resume): anything a tool remembers as "already sent
  // to the model" may no longer be in the context.
  resetVolatileState(): void {
    for (const tool of this.tools.values()) tool.reset?.();
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
