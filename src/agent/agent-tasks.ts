import { EventEmitter } from "node:events";

export type AgentTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentTaskSnapshot {
  id: string;
  prompt: string;
  description?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  result: string;
}

interface AgentTaskRecord {
  id: string;
  prompt: string;
  description?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  result: string;
  controller: AbortController;
  notified: boolean;
}

// Background subagent runs, mirroring src/tasks/manager.ts for shell tasks.
// The payload is a promise-producing closure (a child AgentLoop) instead of
// a child process; finished results are drained into the parent loop's
// message stream at the next step boundary so the main agent learns
// outcomes without polling, and are also surfaced to the UI via "update".
export class AgentTaskManager extends EventEmitter {
  private records = new Map<string, AgentTaskRecord>();
  private counter = 0;

  start(
    run: (signal: AbortSignal) => Promise<string>,
    meta: { prompt: string; description?: string },
  ): AgentTaskSnapshot {
    const id = `agent-${++this.counter}`;
    const rec: AgentTaskRecord = {
      id,
      prompt: meta.prompt,
      description: meta.description,
      status: "running",
      startedAt: Date.now(),
      result: "",
      controller: new AbortController(),
      notified: false,
    };
    this.records.set(id, rec);
    void run(rec.controller.signal)
      .then((result) => this.finish(rec, "completed", result))
      .catch((error) =>
        this.finish(rec, "failed", error instanceof Error ? error.message : String(error)),
      );
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
      if (rec.status === "running") count += 1;
    }
    return count;
  }

  kill(id: string): AgentTaskSnapshot | undefined {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "running") return undefined;
    rec.controller.abort();
    this.finish(rec, "stopped", rec.result || "Stopped by user.");
    return this.snapshot(rec);
  }

  cleanup(): AgentTaskSnapshot[] {
    const killed: AgentTaskSnapshot[] = [];
    for (const rec of this.records.values()) {
      if (rec.status === "running") {
        rec.controller.abort();
        this.finish(rec, "stopped", rec.result || "Stopped on shutdown.");
        killed.push(this.snapshot(rec));
      }
    }
    return killed;
  }

  // Finished tasks whose result has not yet been handed to the parent loop.
  drainNotifications(): AgentTaskSnapshot[] {
    const drained: AgentTaskSnapshot[] = [];
    for (const rec of this.records.values()) {
      if (rec.status !== "running" && !rec.notified) {
        rec.notified = true;
        drained.push(this.snapshot(rec));
      }
    }
    return drained;
  }

  private finish(rec: AgentTaskRecord, status: AgentTaskStatus, result: string): void {
    if (rec.status !== "running") return;
    rec.status = status;
    rec.result = result;
    rec.endedAt = Date.now();
    this.emitUpdate(rec);
  }

  private emitUpdate(rec: AgentTaskRecord): void {
    this.emit("update", this.snapshot(rec));
  }

  private snapshot(rec: AgentTaskRecord): AgentTaskSnapshot {
    return {
      id: rec.id,
      prompt: rec.prompt,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      result: rec.result,
    };
  }
}

export const defaultAgentTasks = new AgentTaskManager();
