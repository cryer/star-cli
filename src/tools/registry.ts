import { bashTool } from "./bash";
import { editFileTool } from "./fs/edit";
import { globTool } from "./fs/glob";
import { grepTool } from "./fs/grep";
import { readFileTool } from "./fs/read";
import { writeFileTool } from "./fs/write";
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
      readFileTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
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
