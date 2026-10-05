import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { childEnv, decodeOutput, killTree, resolveShell, trimUtf8Start } from "../tools/bash";

export type TaskStatus = "running" | "completed" | "failed" | "timed_out" | "stopped";

export interface TaskSnapshot {
  id: string;
  // Which agent loop started the task ("root" for the main agent, a
  // subagent's agentId otherwise); the task_* tools scope subagents to
  // their own tasks while root reaches all.
  ownerId: string;
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
// Finished records are pruned to this many most-recent entries so a long
// session's task history cannot grow without bound; running tasks are never
// evicted.
export const MAX_FINISHED_RECORDS = 50;

const TRUNCATED_PREFIX = "[... earlier output truncated ...]\n";

interface TaskRecord {
  id: string;
  ownerId: string;
  command: string;
  description?: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  // Output accumulates as raw bytes and decodes once per snapshot: a
  // multi-byte character split across chunks must not become U+FFFD, and
  // Windows OEM-codepage (GBK) output needs the whole buffer to re-decode.
  outputChunks: Buffer[];
  outputBytes: number;
  truncated: boolean;
  child: ChildProcess;
  timer?: NodeJS.Timeout;
}

export interface StartTaskOptions {
  command: string;
  description?: string;
  cwd: string;
  timeoutSeconds?: number;
  // Owning agent id for task_* scoping; defaults to "root".
  ownerId?: string;
  // Child environment; defaults to the scrubbed childEnv() (.env API keys
  // removed) so a background command can't print the stored secrets.
  env?: NodeJS.ProcessEnv;
}

export class TaskManager extends EventEmitter {
  private records = new Map<string, TaskRecord>();
  private seq = 0;

  start(opts: StartTaskOptions): TaskSnapshot {
    const id = `task-${++this.seq}`;
    const spec = resolveShell();
    const child = spawn(spec.shell, spec.wrap(opts.command), {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      windowsHide: true,
      // No stdin: background commands that read it would hang until the
      // (much longer) task timeout; give them EOF immediately.
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: the child leads its own process group so killTree can SIGKILL
      // the whole tree with a negative pid (Windows uses taskkill /t).
      detached: process.platform !== "win32",
    });
    const rec: TaskRecord = {
      id,
      ownerId: opts.ownerId ?? "root",
      command: opts.command,
      description: opts.description,
      status: "running",
      startedAt: Date.now(),
      outputChunks: [],
      outputBytes: 0,
      truncated: false,
      child,
    };
    this.records.set(id, rec);

    const append = (d: Buffer) => {
      rec.outputChunks.push(d);
      rec.outputBytes += d.length;
      if (rec.outputBytes > MAX_TASK_OUTPUT) {
        const merged = Buffer.concat(rec.outputChunks, rec.outputBytes);
        const kept = trimUtf8Start(merged.subarray(merged.length - MAX_TASK_OUTPUT));
        rec.outputChunks = [kept];
        rec.outputBytes = kept.length;
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
    this.pruneFinished();
    this.emitUpdate(rec);
  }

  private pruneFinished(): void {
    const finished = [...this.records.values()].filter((rec) => rec.status !== "running");
    if (finished.length <= MAX_FINISHED_RECORDS) return;
    finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const rec of finished.slice(0, finished.length - MAX_FINISHED_RECORDS)) {
      this.records.delete(rec.id);
    }
  }

  private emitUpdate(rec: TaskRecord): void {
    this.emit("update", this.snapshot(rec));
  }

  private snapshot(rec: TaskRecord): TaskSnapshot {
    const output = decodeOutput(Buffer.concat(rec.outputChunks, rec.outputBytes));
    return {
      id: rec.id,
      ownerId: rec.ownerId,
      command: rec.command,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      exitCode: rec.exitCode,
      output: rec.truncated ? TRUNCATED_PREFIX + output : output,
    };
  }
}

export const defaultTaskManager = new TaskManager();
