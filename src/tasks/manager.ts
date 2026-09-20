import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { killTree, resolveShell } from "../tools/bash";

export type TaskStatus = "running" | "completed" | "failed" | "timed_out" | "stopped";

export interface TaskSnapshot {
  id: string;
  command: string;
  description?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  output: string;
}

export const MAX_TASK_OUTPUT = 100_000;
export const DEFAULT_TASK_TIMEOUT = 3600;

const TRUNCATED_PREFIX = "[... earlier output truncated ...]\n";

interface TaskRecord {
  id: string;
  command: string;
  description?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  output: string;
  truncated: boolean;
  child: ChildProcess;
  timer?: NodeJS.Timeout;
}

export interface StartTaskOptions {
  command: string;
  description?: string;
  cwd: string;
  timeoutSeconds?: number;
}

export class TaskManager extends EventEmitter {
  private records = new Map<string, TaskRecord>();
  private seq = 0;

  start(opts: StartTaskOptions): TaskSnapshot {
    const id = `task-${++this.seq}`;
    const spec = resolveShell();
    const child = spawn(spec.shell, spec.wrap(opts.command), {
      cwd: opts.cwd,
      windowsHide: true,
    });
    const rec: TaskRecord = {
      id,
      command: opts.command,
      description: opts.description,
      status: "running",
      startedAt: Date.now(),
      output: "",
      truncated: false,
      child,
    };
    this.records.set(id, rec);

    const append = (d: Buffer) => {
      rec.output += d.toString("utf8");
      if (rec.output.length > MAX_TASK_OUTPUT) {
        rec.output = rec.output.slice(-MAX_TASK_OUTPUT);
        rec.truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      append(Buffer.from(`Failed to start shell '${spec.label}': ${err.message}\n`));
      if (rec.status === "running") {
        this.finish(rec, "failed", null);
      }
    });
    child.on("close", (code) => {
      if (rec.status !== "running") return;
      this.finish(rec, code === 0 ? "completed" : "failed", code);
    });

    const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT;
    rec.timer = setTimeout(() => this.terminate(rec, "timed_out"), timeoutSeconds * 1000);
    rec.timer.unref();

    this.emitUpdate(rec);
    return this.snapshot(rec);
  }

  get(id: string): TaskSnapshot | undefined {
    const rec = this.records.get(id);
    return rec ? this.snapshot(rec) : undefined;
  }

  list(): TaskSnapshot[] {
    return [...this.records.values()].map((rec) => this.snapshot(rec));
  }

  runningCount(): number {
    let count = 0;
    for (const rec of this.records.values()) {
      if (rec.status === "running") count += 1;
    }
    return count;
  }

  kill(id: string): TaskSnapshot | undefined {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "running") return undefined;
    this.terminate(rec, "stopped");
    return this.snapshot(rec);
  }

  cleanup(): TaskSnapshot[] {
    const killed: TaskSnapshot[] = [];
    for (const rec of this.records.values()) {
      if (rec.status === "running") {
        this.terminate(rec, "stopped");
        killed.push(this.snapshot(rec));
      }
    }
    return killed;
  }

  private terminate(rec: TaskRecord, status: TaskStatus): void {
    killTree(rec.child);
    this.finish(rec, status, null);
  }

  private finish(rec: TaskRecord, status: TaskStatus, exitCode: number | null): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.status = status;
    rec.exitCode = exitCode;
    rec.endedAt = Date.now();
    this.emitUpdate(rec);
  }

  private emitUpdate(rec: TaskRecord): void {
    this.emit("update", this.snapshot(rec));
  }

  private snapshot(rec: TaskRecord): TaskSnapshot {
    return {
      id: rec.id,
      command: rec.command,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      exitCode: rec.exitCode,
      output: rec.truncated ? TRUNCATED_PREFIX + rec.output : rec.output,
    };
  }
}

export const defaultTaskManager = new TaskManager();
