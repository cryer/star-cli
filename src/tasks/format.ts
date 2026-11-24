import type { AgentTaskSnapshot } from "../agent/agent-tasks";
import type { TaskSnapshot } from "./manager";

export function formatDuration(startedAt: number, endedAt?: number): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatStatus(task: TaskSnapshot): string {
  const duration = formatDuration(task.startedAt, task.endedAt);
  if (task.status === "running" || task.status === "stopping") {
    return `${task.status} ${duration}`;
  }
  const exit =
    task.exitCode === null || task.exitCode === undefined ? "" : `, exit ${task.exitCode}`;
  return `${task.status}${exit} after ${duration}`;
}

export function formatTaskLine(task: TaskSnapshot): string {
  const label = task.description ? `${task.description} (${task.command})` : task.command;
  return `${task.id} [${formatStatus(task)}] ${label}`;
}

export function formatTaskList(tasks: TaskSnapshot[]): string {
  if (tasks.length === 0) return "No background tasks.";
  return `Background tasks:\n${tasks.map(formatTaskLine).join("\n")}`;
}

export function formatAgentTaskList(tasks: AgentTaskSnapshot[]): string {
  if (tasks.length === 0) return "No background subagents.";
  const lines = tasks.map((task) => {
    const duration = formatDuration(task.startedAt, task.endedAt);
    const label = task.description ?? task.prompt.slice(0, 60);
    const status =
      task.status === "running" || task.status === "stopping"
        ? `${task.status} ${duration}`
        : `${task.status} after ${duration}`;
    return `${task.id} [${status}] ${label}`;
  });
  return `Background subagents:\n${lines.join("\n")}`;
}

export function formatTaskStarted(task: TaskSnapshot): string {
  const label = task.description ? `${task.description} (${task.command})` : task.command;
  return `Background task ${task.id} started: ${label}`;
}

export function formatTaskFinished(task: TaskSnapshot): string {
  const exit =
    task.exitCode === null || task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`;
  switch (task.status) {
    case "completed":
      return `Background task ${task.id} finished${exit}: ${task.command}`;
    case "failed":
      return `Background task ${task.id} failed${exit}: ${task.command}`;
    case "timed_out":
      return `Background task ${task.id} timed out: ${task.command}`;
    case "stopped":
      return `Background task ${task.id} stopped: ${task.command}`;
    case "stopping":
      return `Background task ${task.id} stopping: ${task.command}`;
    case "stop_failed":
      return `Background task ${task.id} stop failed: ${task.stopError ?? "process state is unconfirmed"}`;
    default:
      return `Background task ${task.id}: ${task.command}`;
  }
}
