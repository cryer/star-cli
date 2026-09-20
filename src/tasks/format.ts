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
  if (task.status === "running") return `running ${duration}`;
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
    default:
      return `Background task ${task.id}: ${task.command}`;
  }
}
