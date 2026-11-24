import { z } from "zod";
import { type AgentTaskSnapshot, defaultAgentTasks } from "../agent/agent-tasks";
import { formatDuration, formatTaskLine, formatTaskList } from "../tasks/format";
import { type TaskSnapshot, defaultTaskManager } from "../tasks/manager";
import { MAX_OUTPUT, trimUtf8Start } from "./bash";
import type { Tool, ToolContext } from "./types";

const idSchema = z.object({
  id: z.string().describe("Task id, e.g. task-1 or agent-1"),
});

const outputSchema = idSchema.extend({
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Absolute shell output byte offset returned as nextOffset by the previous read"),
});

// Aligns with the foreground bash output cap: keep a UTF-8-safe tail.
function truncateOutput(s: string): string {
  const bytes = Buffer.from(s);
  if (bytes.length <= MAX_OUTPUT) return s;
  const tail = trimUtf8Start(bytes.subarray(bytes.length - MAX_OUTPUT)).toString("utf8");
  return `[... earlier output truncated; showing the last ${MAX_OUTPUT} bytes ...]\n${tail}`;
}

// Shell tasks are owned by the agent that started them: root sees and
// controls everything, a subagent only its own tasks — otherwise one
// subagent could kill the parent's (or a sibling's) background work.
// Unowned/foreign tasks answer "Unknown task" so their existence doesn't
// leak either. Background subagents (agent-*) always belong to root:
// subagents can't spawn subagents.
function callerId(ctx: ToolContext): string {
  return ctx.agentId ?? "root";
}

function accessibleShellTask(ctx: ToolContext, id: string): TaskSnapshot | undefined {
  const task = defaultTaskManager.get(id);
  if (!task) return undefined;
  const caller = callerId(ctx);
  return caller === "root" || task.ownerId === caller ? task : undefined;
}

function formatAgentTaskLine(task: AgentTaskSnapshot): string {
  const duration = formatDuration(task.startedAt, task.endedAt);
  const label = task.description ?? task.prompt.slice(0, 60);
  const status =
    task.status === "running" || task.status === "stopping"
      ? `${task.status} ${duration}`
      : `${task.status} after ${duration}`;
  return `${task.id} [${status}] ${label}`;
}

export const taskListTool: Tool = {
  name: "task_list",
  description: "List background tasks (shell commands and subagents) with status and runtime.",
  permission: "read",
  parameters: z.object({}),
  execute(_args, ctx) {
    const caller = callerId(ctx);
    const shell = formatTaskList(
      defaultTaskManager.list().filter((t) => caller === "root" || t.ownerId === caller),
    );
    const agents = caller === "root" ? defaultAgentTasks.list() : [];
    const agentLines =
      agents.length === 0
        ? "No background subagents."
        : `Background subagents:\n${agents.map(formatAgentTaskLine).join("\n")}`;
    return Promise.resolve({ content: `${shell}\n${agentLines}` });
  },
};

export const taskOutputTool: Tool<typeof outputSchema> = {
  name: "task_output",
  description:
    "Read the current output of a background task (shell command or subagent; works while still running). For shell tasks, pass offset to read only new bytes and receive the next cursor.",
  permission: "read",
  parameters: outputSchema,
  execute(args, ctx) {
    const shell = accessibleShellTask(ctx, args.id);
    if (shell) {
      if (args.offset !== undefined) {
        const chunk = defaultTaskManager.outputSince(args.id, args.offset);
        if (chunk) {
          const body = truncateOutput(chunk.output.replace(/\s+$/, "") || "(no new output)");
          return Promise.resolve({
            content: `${formatTaskLine(shell)}\n${body}\noutputStart: ${chunk.outputStart}\nnextOffset: ${chunk.nextOffset}`,
          });
        }
      }
      const body = truncateOutput(shell.output.replace(/\s+$/, "") || "(no output yet)");
      return Promise.resolve({ content: `${formatTaskLine(shell)}\n${body}` });
    }
    const agent = callerId(ctx) === "root" ? defaultAgentTasks.get(args.id) : undefined;
    if (agent) {
      const active = agent.status === "running" || agent.status === "stopping";
      const body = active
        ? truncateOutput(agent.progress.replace(/\s+$/, "") || `(${agent.status})`)
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
  async execute(args, ctx) {
    const shell = accessibleShellTask(ctx, args.id);
    const agent = shell || callerId(ctx) !== "root" ? undefined : defaultAgentTasks.get(args.id);
    const task = shell ?? agent;
    if (!task) {
      return { content: `Unknown task: ${args.id}`, isError: true };
    }
    if (task.status !== "running" && task.status !== "stopping") {
      return {
        content: `Task ${args.id} is not running (status: ${task.status}).`,
        isError: true,
      };
    }
    let stopped: TaskSnapshot | AgentTaskSnapshot | undefined;
    if (shell) {
      stopped = await defaultTaskManager.kill(args.id);
    } else {
      stopped = await defaultAgentTasks.kill(args.id);
      await defaultTaskManager.cleanupOwner(args.id);
    }
    if (stopped?.status === "stop_failed") {
      return {
        content: `Failed to stop task ${args.id}: ${stopped.stopError ?? "process state is unconfirmed"}`,
        isError: true,
      };
    }
    return { content: `Task ${args.id} ${stopped?.status ?? "stopped"}.` };
  },
};
