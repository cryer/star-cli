import { bashTool } from "./bash";
import { editFileTool } from "./fs/edit";
import { globTool } from "./fs/glob";
import { grepTool } from "./fs/grep";
import { readFileTool } from "./fs/read";
import { writeFileTool } from "./fs/write";
import { createTodoTools } from "./todo";
import type { Tool } from "./types";
import { webFetchTool } from "./web/fetch";
import { webSearchTool } from "./web/search";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor() {
    for (const tool of [
      readFileTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      bashTool,
      webFetchTool,
      webSearchTool,
      ...createTodoTools(),
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
