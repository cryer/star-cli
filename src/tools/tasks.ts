import { z } from "zod";
import { formatTaskLine, formatTaskList } from "../tasks/format";
import { defaultTaskManager } from "../tasks/manager";
import type { Tool } from "./types";

const idSchema = z.object({
  id: z.string().describe("Task id, e.g. task-1"),
});

export const taskListTool: Tool = {
  name: "task_list",
  description: "List background shell tasks with status, runtime, and exit code.",
  permission: "read",
  parameters: z.object({}),
  execute() {
    return Promise.resolve({ content: formatTaskList(defaultTaskManager.list()) });
  },
};

export const taskOutputTool: Tool<typeof idSchema> = {
  name: "task_output",
  description: "Read the current output of a background shell task (works while still running).",
  permission: "read",
  parameters: idSchema,
  execute(args) {
    const task = defaultTaskManager.get(args.id);
    if (!task) {
      return Promise.resolve({ content: `Unknown task: ${args.id}`, isError: true });
    }
    const body = task.output.replace(/\s+$/, "") || "(no output yet)";
    return Promise.resolve({ content: `${formatTaskLine(task)}\n${body}` });
  },
};

export const taskKillTool: Tool<typeof idSchema> = {
  name: "task_kill",
  description: "Stop a running background shell task (kills the whole process tree).",
  permission: "exec",
  parameters: idSchema,
  execute(args) {
    const task = defaultTaskManager.get(args.id);
    if (!task) {
      return Promise.resolve({ content: `Unknown task: ${args.id}`, isError: true });
    }
    if (task.status !== "running") {
      return Promise.resolve({
        content: `Task ${args.id} is not running (status: ${task.status}).`,
        isError: true,
      });
    }
    defaultTaskManager.kill(args.id);
    return Promise.resolve({ content: `Task ${args.id} stopped.` });
  },
};
