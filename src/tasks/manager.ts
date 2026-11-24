import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { directKill, killTree } from "../core/process";
import { childEnv, decodeOutput, resolveShell, trimUtf8End, trimUtf8Start } from "../tools/bash";

export type TaskStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "timed_out"
  | "stopped"
  | "stop_failed";

type TerminalTaskStatus = Exclude<TaskStatus, "running" | "stopping">;

export interface TaskSnapshot {
  id: string;
  notificationId: string;
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
  stopError?: string;
  output: string;
  outputStart: number;
  nextOffset: number;
}

export interface TaskOutputChunk {
  output: string;
  outputStart: number;
  nextOffset: number;
  truncated: boolean;
}

export const MAX_TASK_OUTPUT = 100_000;
export const DEFAULT_TASK_TIMEOUT = 3600;
export const MAX_TASK_TIMEOUT = 3600;
// Finished records are pruned to this many most-recent entries so a long
// session's task history cannot grow without bound; active and unacknowledged
// records are never evicted.
export const MAX_FINISHED_RECORDS = 50;

const TRUNCATED_PREFIX = "[... earlier output truncated ...]\n";

interface TaskRecord {
  id: string;
  ownerId: string;
  command: string;
  description?: string;
  status: TaskStatus;
  terminalStatus?: TerminalTaskStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  stopError?: string;
  // Output accumulates as raw bytes and decodes once per snapshot: a
  // multi-byte character split across chunks must not become U+FFFD, and
  // Windows OEM-codepage (GBK) output needs the whole buffer to re-decode.
  outputChunks: Buffer[];
  outputBytes: number;
  totalOutputBytes: number;
  truncated: boolean;
  child: ChildProcess;
  closed: Promise<void>;
  stopPromise?: Promise<TaskSnapshot>;
  notified: boolean;
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

function isTerminal(status: TaskStatus): boolean {
  return status !== "running" && status !== "stopping";
}

export function readOutputChunk(
  buffered: Buffer,
  outputStart: number,
  offset: number,
): TaskOutputChunk {
  const totalOutputBytes = outputStart + buffered.length;
  const requested = Math.max(0, Math.floor(offset));
  const truncated = requested < outputStart;
  const start = Math.min(Math.max(requested, outputStart), totalOutputBytes);
  const output = trimUtf8Start(buffered.subarray(start - outputStart));
  const complete = trimUtf8End(output);
  return {
    output: (truncated ? TRUNCATED_PREFIX : "") + decodeOutput(complete),
    outputStart,
    nextOffset: totalOutputBytes - (output.length - complete.length),
    truncated,
  };
}

export class TaskManager extends EventEmitter {
  private records = new Map<string, TaskRecord>();
  private seq = 0;
  private readonly namespace = randomUUID();

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
    let resolveClosed: () => void = () => {};
    const rec: TaskRecord = {
      id,
      ownerId: opts.ownerId ?? "root",
      command: opts.command,
      description: opts.description,
      status: "running",
      startedAt: Date.now(),
      outputChunks: [],
      outputBytes: 0,
      totalOutputBytes: 0,
      truncated: false,
      child,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      notified: false,
    };
    this.records.set(id, rec);

    const append = (d: Buffer) => {
      rec.outputChunks.push(d);
      rec.outputBytes += d.length;
      rec.totalOutputBytes += d.length;
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
    });
    child.on("close", (code) => {
      if (rec.status === "running") {
        this.finish(rec, code === 0 ? "completed" : "failed", code);
      } else if (rec.status === "stopping" || rec.status === "stop_failed") {
        rec.stopError = undefined;
        this.finish(rec, rec.terminalStatus ?? "stopped", code);
      }
      resolveClosed();
    });

    const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT;
    rec.timer = setTimeout(() => {
      void this.terminate(rec, "timed_out");
    }, timeoutSeconds * 1000);
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
      if (!isTerminal(rec.status)) count += 1;
    }
    return count;
  }

  outputSince(id: string, offset: number): TaskOutputChunk | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    const outputStart = rec.totalOutputBytes - rec.outputBytes;
    return readOutputChunk(Buffer.concat(rec.outputChunks, rec.outputBytes), outputStart, offset);
  }

  async kill(id: string): Promise<TaskSnapshot | undefined> {
    const rec = this.records.get(id);
    if (!rec || isTerminal(rec.status)) return undefined;
    return this.terminate(rec, "stopped");
  }

  async cleanup(): Promise<TaskSnapshot[]> {
    return this.cleanupMatching(() => true);
  }

  async cleanupOwner(ownerId: string): Promise<TaskSnapshot[]> {
    return this.cleanupMatching((rec) => rec.ownerId === ownerId);
  }

  peekNotifications(): TaskSnapshot[] {
    const notifications: TaskSnapshot[] = [];
    for (const rec of this.records.values()) {
      if (isTerminal(rec.status) && !rec.notified) {
        notifications.push(this.snapshot(rec));
      }
    }
    return notifications;
  }

  ackNotifications(ids: Iterable<string>): void {
    const acknowledged = new Set(ids);
    for (const id of acknowledged) {
      const rec = this.records.get(id);
      if (rec && isTerminal(rec.status)) rec.notified = true;
    }
    this.pruneFinished();
  }

  private async cleanupMatching(matches: (rec: TaskRecord) => boolean): Promise<TaskSnapshot[]> {
    const active = [...this.records.values()].filter(
      (rec) => !isTerminal(rec.status) && matches(rec),
    );
    return Promise.all(active.map((rec) => this.terminate(rec, "stopped")));
  }

  private terminate(rec: TaskRecord, status: TerminalTaskStatus): Promise<TaskSnapshot> {
    if (rec.stopPromise) return rec.stopPromise;
    if (isTerminal(rec.status)) return Promise.resolve(this.snapshot(rec));
    rec.status = "stopping";
    rec.terminalStatus = status;
    if (rec.timer) clearTimeout(rec.timer);
    rec.stopPromise = (async () => {
      await killTree(rec.child).catch(() => {});
      let closeTimer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        rec.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          closeTimer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      if (closeTimer) clearTimeout(closeTimer);
      if (!closed && rec.status === "stopping") {
        rec.child.stdout?.destroy();
        rec.child.stderr?.destroy();
        directKill(rec.child);
        rec.stopError =
          "Timed out waiting for process close after termination; process state is unconfirmed.";
        this.finish(rec, "stop_failed", null);
      }
      return this.snapshot(rec);
    })();
    this.emitUpdate(rec);
    return rec.stopPromise;
  }

  private finish(rec: TaskRecord, status: TerminalTaskStatus, exitCode: number | null): void {
    if (isTerminal(rec.status) && rec.status !== "stop_failed") return;
    if (rec.timer) clearTimeout(rec.timer);
    rec.status = status;
    rec.exitCode = exitCode;
    rec.endedAt = Date.now();
    this.pruneFinished();
    this.emitUpdate(rec);
  }

  private pruneFinished(): void {
    const finished = [...this.records.values()].filter((rec) => isTerminal(rec.status));
    if (finished.length <= MAX_FINISHED_RECORDS) return;
    finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    let excess = finished.length - MAX_FINISHED_RECORDS;
    for (const rec of finished) {
      if (excess <= 0) return;
      if (rec.notified) {
        this.records.delete(rec.id);
        excess -= 1;
      }
    }
  }

  private emitUpdate(rec: TaskRecord): void {
    this.emit("update", this.snapshot(rec));
  }

  private snapshot(rec: TaskRecord): TaskSnapshot {
    const output = decodeOutput(Buffer.concat(rec.outputChunks, rec.outputBytes));
    return {
      id: rec.id,
      notificationId: `${this.namespace}:${rec.id}`,
      ownerId: rec.ownerId,
      command: rec.command,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      exitCode: rec.exitCode,
      stopError: rec.stopError,
      output: rec.truncated ? TRUNCATED_PREFIX + output : output,
      outputStart: rec.totalOutputBytes - rec.outputBytes,
      nextOffset: rec.totalOutputBytes,
    };
  }
}

export const defaultTaskManager = new TaskManager();
