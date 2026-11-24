import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type AgentTaskStatus = "running" | "stopping" | "completed" | "failed" | "stopped";

export interface AgentTaskSnapshot {
  id: string;
  notificationId: string;
  prompt: string;
  description?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  result: string;
  progress: string;
}

interface AgentTaskRecord {
  id: string;
  prompt: string;
  description?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  result: string;
  progress: string;
  controller: AbortController;
  settled: Promise<void>;
  stopRequested: boolean;
  stopResult?: string;
  notified: boolean;
}

export const MAX_AGENT_TASK_PROGRESS = 20_000;

// Finished records are kept only so task_output can still answer for recent
// tasks; once the parent has acknowledged them they are dropped oldest-first
// beyond this cap, so a long session cannot accumulate them without bound.
const MAX_FINISHED_RECORDS = 50;

function isTerminal(status: AgentTaskStatus): boolean {
  return status !== "running" && status !== "stopping";
}

// Background subagent runs, mirroring src/tasks/manager.ts for shell tasks.
// The payload is a promise-producing closure (a child AgentLoop) instead of
// a child process; finished results are delivered to the parent loop's
// message stream at explicit flush points so the main agent learns outcomes
// without polling, and are also surfaced to the UI via "update".
export class AgentTaskManager extends EventEmitter {
  private records = new Map<string, AgentTaskRecord>();
  private counter = 0;
  private readonly namespace = randomUUID();

  start(
    run: (signal: AbortSignal, reportProgress: (progress: string) => void) => Promise<string>,
    meta: { prompt: string; description?: string },
  ): AgentTaskSnapshot {
    const id = `agent-${++this.counter}`;
    let resolveSettled: () => void = () => {};
    const rec: AgentTaskRecord = {
      id,
      prompt: meta.prompt,
      description: meta.description,
      status: "running",
      startedAt: Date.now(),
      result: "",
      progress: "",
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      stopRequested: false,
      notified: false,
    };
    this.records.set(id, rec);

    let execution: Promise<string>;
    try {
      execution = run(rec.controller.signal, (progress) => {
        if (isTerminal(rec.status)) return;
        rec.progress = (rec.progress + progress).slice(-MAX_AGENT_TASK_PROGRESS);
      });
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution
      .then(
        (result) => {
          if (rec.stopRequested) {
            this.finish(rec, "stopped", rec.stopResult ?? "Stopped by user.");
          } else {
            this.finish(rec, "completed", result);
          }
        },
        (error) => {
          if (rec.stopRequested) {
            this.finish(rec, "stopped", rec.stopResult ?? "Stopped by user.");
          } else {
            this.finish(rec, "failed", error instanceof Error ? error.message : String(error));
          }
        },
      )
      .then(resolveSettled, resolveSettled);
    this.emitUpdate(rec);
    return this.snapshot(rec);
  }

  get(id: string): AgentTaskSnapshot | undefined {
    const rec = this.records.get(id);
    return rec ? this.snapshot(rec) : undefined;
  }

  list(): AgentTaskSnapshot[] {
    return [...this.records.values()].map((rec) => this.snapshot(rec));
  }

  runningCount(): number {
    let count = 0;
    for (const rec of this.records.values()) {
      if (!isTerminal(rec.status)) count += 1;
    }
    return count;
  }

  async kill(id: string): Promise<AgentTaskSnapshot | undefined> {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (isTerminal(rec.status)) return this.snapshot(rec);
    if (!rec.stopRequested) {
      rec.stopRequested = true;
      rec.stopResult = "Stopped by user.";
      rec.status = "stopping";
      this.emitUpdate(rec);
      rec.controller.abort();
    }
    await rec.settled;
    return this.snapshot(rec);
  }

  async cleanup(): Promise<AgentTaskSnapshot[]> {
    const active = [...this.records.values()].filter((rec) => !isTerminal(rec.status));
    return Promise.all(
      active.map(async (rec) => {
        if (!rec.stopRequested) {
          rec.stopRequested = true;
          rec.stopResult = "Stopped on shutdown.";
          rec.status = "stopping";
          this.emitUpdate(rec);
          rec.controller.abort();
        }
        await rec.settled;
        return this.snapshot(rec);
      }),
    );
  }

  peekNotifications(): AgentTaskSnapshot[] {
    const notifications: AgentTaskSnapshot[] = [];
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

  // Map iteration is insertion-ordered, so the first finished records met are
  // the oldest. Never drop an unacknowledged record: the parent has not seen
  // its result yet. Active records are untouched.
  private pruneFinished(): void {
    let finished = 0;
    for (const rec of this.records.values()) {
      if (isTerminal(rec.status)) finished += 1;
    }
    let excess = finished - MAX_FINISHED_RECORDS;
    if (excess <= 0) return;
    for (const rec of this.records.values()) {
      if (excess <= 0) return;
      if (isTerminal(rec.status) && rec.notified) {
        this.records.delete(rec.id);
        excess -= 1;
      }
    }
  }

  private finish(rec: AgentTaskRecord, status: AgentTaskStatus, result: string): void {
    if (isTerminal(rec.status)) return;
    rec.status = status;
    rec.result = result;
    rec.endedAt = Date.now();
    this.pruneFinished();
    this.emitUpdate(rec);
  }

  private emitUpdate(rec: AgentTaskRecord): void {
    this.emit("update", this.snapshot(rec));
  }

  private snapshot(rec: AgentTaskRecord): AgentTaskSnapshot {
    return {
      id: rec.id,
      notificationId: `${this.namespace}:${rec.id}`,
      prompt: rec.prompt,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      result: rec.result,
      progress: rec.progress,
    };
  }
}

export const defaultAgentTasks = new AgentTaskManager();

// One-line REPL announcement for a task status change. A failure is the final
// state after the child loop's own retries, so the reason (first line of the
// failure report, which reads "Subagent failed: <cause>") is surfaced inline —
// a bare "failed" looks like a transient hiccup even though the full report
// has been delivered to the main agent, which decides how to recover.
export function formatAgentTaskUpdate(task: AgentTaskSnapshot): string {
  const label = task.description ? `: ${task.description}` : "";
  if (task.status === "running") {
    return `Background subagent ${task.id} started${label}`;
  }
  let text = `Background subagent ${task.id} ${task.status}${label}`;
  if (task.status === "failed") {
    const reason = (task.result.split("\n")[0] ?? "").replace(/^Subagent failed:\s*/, "");
    if (reason) {
      text += ` — ${reason.length > 140 ? `${reason.slice(0, 140)}…` : reason}`;
    }
  }
  return text;
}
