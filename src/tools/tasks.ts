import { z } from "zod";
import { type AgentTaskSnapshot, defaultAgentTasks } from "../agent/agent-tasks";
import { formatDuration, formatTaskLine, formatTaskList } from "../tasks/format";
import { defaultTaskManager } from "../tasks/manager";
import { MAX_OUTPUT } from "./bash";
import type { Tool } from "./types";

const idSchema = z.object({
  id: z.string().describe("Task id, e.g. task-1 or agent-1"),
});

// Aligns with the foreground bash output cap: keep the tail, note the cut.
function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `[... earlier output truncated; showing the last ${MAX_OUTPUT} characters ...]\n${s.slice(-MAX_OUTPUT)}`;
}

function formatAgentTaskLine(task: AgentTaskSnapshot): string {
  const duration = formatDuration(task.startedAt, task.endedAt);
  const label = task.description ?? task.prompt.slice(0, 60);
  const status =
    task.status === "running" ? `running ${duration}` : `${task.status} after ${duration}`;
  return `${task.id} [${status}] ${label}`;
}

export const taskListTool: Tool = {
  name: "task_list",
  description: "List background tasks (shell commands and subagents) with status and runtime.",
  permission: "read",
  parameters: z.object({}),
  execute() {
    const shell = formatTaskList(defaultTaskManager.list());
    const agents = defaultAgentTasks.list();
    const agentLines =
      agents.length === 0
        ? "No background subagents."
        : `Background subagents:\n${agents.map(formatAgentTaskLine).join("\n")}`;
    return Promise.resolve({ content: `${shell}\n${agentLines}` });
  },
};

export const taskOutputTool: Tool<typeof idSchema> = {
  name: "task_output",
  description:
    "Read the current output of a background task (shell command or subagent; works while still running).",
  permission: "read",
  parameters: idSchema,
  execute(args) {
    const shell = defaultTaskManager.get(args.id);
    if (shell) {
      const body = truncateOutput(shell.output.replace(/\s+$/, "") || "(no output yet)");
      return Promise.resolve({ content: `${formatTaskLine(shell)}\n${body}` });
    }
    const agent = defaultAgentTasks.get(args.id);
    if (agent) {
      const body =
        agent.status === "running"
          ? "(still running)"
          : truncateOutput(agent.result.replace(/\s+$/, "") || "(no report)");
      return Promise.resolve({ content: `${formatAgentTaskLine(agent)}\n${body}` });
    }
    return Promise.resolve({ content: `Unknown task: ${args.id}`, isError: true });
  },
};

export const taskKillTool: Tool<typeof idSchema> = {
  name: "task_kill",
  description: "Stop a running background task (shell command process tree or subagent).",
  permission: "exec",
  parameters: idSchema,
  execute(args) {
    const shell = defaultTaskManager.get(args.id);
    const agent = shell ? undefined : defaultAgentTasks.get(args.id);
    const task = shell ?? agent;
    if (!task) {
      return Promise.resolve({ content: `Unknown task: ${args.id}`, isError: true });
    }
    if (task.status !== "running") {
      return Promise.resolve({
        content: `Task ${args.id} is not running (status: ${task.status}).`,
        isError: true,
      });
    }
    if (shell) {
      defaultTaskManager.kill(args.id);
    } else {
      defaultAgentTasks.kill(args.id);
    }
    return Promise.resolve({ content: `Task ${args.id} stopped.` });
  },
};
