import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTaskList, formatTaskStarted } from "../src/tasks/format";
import {
  DEFAULT_TASK_TIMEOUT,
  MAX_FINISHED_RECORDS,
  MAX_TASK_OUTPUT,
  TaskManager,
  type TaskSnapshot,
  defaultTaskManager,
} from "../src/tasks/manager";
import { createDefaultRegistry } from "../src/tools";
import type { ToolResult } from "../src/tools/types";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "star-tasks-test-"));
});

afterEach(() => {
  defaultTaskManager.cleanup();
});

function waitForTerminal(
  manager: TaskManager,
  id: string,
  timeoutMs = 10000,
): Promise<TaskSnapshot> {
  const existing = manager.get(id);
  if (existing && existing.status !== "running") {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("update", onUpdate);
      reject(new Error(`timed out waiting for ${id} to finish`));
    }, timeoutMs);
    const onUpdate = (task: TaskSnapshot) => {
      if (task.id === id && task.status !== "running") {
        clearTimeout(timer);
        manager.off("update", onUpdate);
        resolve(task);
      }
    };
    manager.on("update", onUpdate);
  });
}

describe("TaskManager", () => {
  it("runs a command to completion and captures output", async () => {
    const manager = new TaskManager();
    const started = manager.start({ command: "node -e \"console.log('task-hello')\"", cwd });
    expect(started.id).toBe("task-1");
    expect(started.status).toBe("running");

    const finished = await waitForTerminal(manager, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toContain("task-hello");
    expect(finished.endedAt).toBeDefined();
    expect(manager.runningCount()).toBe(0);
  });

  it("marks non-zero exits as failed with the exit code", async () => {
    const manager = new TaskManager();
    const started = manager.start({
      command: "node -e \"console.error('boom'); process.exit(3)\"",
      cwd,
    });
    const finished = await waitForTerminal(manager, started.id);
    expect(finished.status).toBe("failed");
    expect(finished.exitCode).toBe(3);
    expect(finished.output).toContain("boom");
  });

  it("emits update events on start and finish", async () => {
    const manager = new TaskManager();
    const events: TaskSnapshot[] = [];
    manager.on("update", (task: TaskSnapshot) => events.push(task));
    const started = manager.start({ command: 'node -e ""', cwd });
    await waitForTerminal(manager, started.id);
    expect(events.map((e) => e.status)).toEqual(["running", "completed"]);
  });

  it("assigns incrementing ids", () => {
    const manager = new TaskManager();
    const a = manager.start({ command: 'node -e "setTimeout(() => {}, 30000)"', cwd });
    const b = manager.start({ command: 'node -e "setTimeout(() => {}, 30000)"', cwd });
    expect(a.id).toBe("task-1");
    expect(b.id).toBe("task-2");
    expect(manager.runningCount()).toBe(2);
    manager.cleanup();
  });

  it("kill() stops a running task", async () => {
    const manager = new TaskManager();
    const started = manager.start({ command: 'node -e "setTimeout(() => {}, 30000)"', cwd });
    const killed = manager.kill(started.id);
    expect(killed?.status).toBe("stopped");
    expect(manager.get(started.id)?.status).toBe("stopped");
    expect(manager.kill(started.id)).toBeUndefined();
    expect(manager.kill("task-999")).toBeUndefined();
  });

  it("times out tasks exceeding their timeout", async () => {
    const manager = new TaskManager();
    const started = manager.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      cwd,
      timeoutSeconds: 1,
    });
    const finished = await waitForTerminal(manager, started.id);
    expect(finished.status).toBe("timed_out");
  }, 15000);

  it("truncates output to the tail cap with a marker", async () => {
    const manager = new TaskManager();
    const started = manager.start({
      command: `node -e "process.stdout.write('x'.repeat(${MAX_TASK_OUTPUT * 2}))"`,
      cwd,
    });
    const finished = await waitForTerminal(manager, started.id);
    expect(finished.status).toBe("completed");
    expect(finished.output.length).toBeLessThanOrEqual(MAX_TASK_OUTPUT + 100);
    expect(finished.output).toContain("earlier output truncated");
  }, 15000);

  it("cleanup() stops all running tasks", () => {
    const manager = new TaskManager();
    manager.start({ command: 'node -e "setTimeout(() => {}, 30000)"', cwd });
    manager.start({ command: 'node -e "setTimeout(() => {}, 30000)"', cwd });
    const killed = manager.cleanup();
    expect(killed).toHaveLength(2);
    expect(killed.every((t) => t.status === "stopped")).toBe(true);
    expect(manager.runningCount()).toBe(0);
  });

  it("has a generous default timeout", () => {
    expect(DEFAULT_TASK_TIMEOUT).toBeGreaterThanOrEqual(3600);
  });

  it("prunes finished records to the most recent 50, keeping running ones", async () => {
    const manager = new TaskManager();
    const started: TaskSnapshot[] = [];
    for (let i = 0; i < MAX_FINISHED_RECORDS + 3; i++) {
      started.push(manager.start({ command: 'node -e ""', cwd }));
    }
    for (const task of started) {
      await waitForTerminal(manager, task.id);
    }
    const listed = manager.list();
    expect(listed).toHaveLength(MAX_FINISHED_RECORDS);
    expect(listed.some((t) => t.id === started[0]?.id)).toBe(false);
    expect(listed.some((t) => t.id === started[started.length - 1]?.id)).toBe(true);
  }, 30000);
});

describe("formatTaskList", () => {
  it("says so when there are no tasks", () => {
    expect(formatTaskList([])).toBe("No background tasks.");
  });
});

describe("formatTaskStarted", () => {
  const base: TaskSnapshot = {
    id: "task-3",
    command: "pnpm test",
    status: "running",
    startedAt: Date.now(),
    output: "",
  };

  it("includes the description when present", () => {
    expect(formatTaskStarted({ ...base, description: "run tests" })).toBe(
      "Background task task-3 started: run tests (pnpm test)",
    );
  });

  it("falls back to the bare command", () => {
    expect(formatTaskStarted(base)).toBe("Background task task-3 started: pnpm test");
  });
});

describe("background task tools", () => {
  const registry = createDefaultRegistry();

  function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = registry.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.execute(args as never, { cwd });
  }

  it("task_list reports the empty state before any task runs", async () => {
    // Must stay the first test in this describe block: defaultTaskManager is a
    // shared singleton and keeps records of finished tasks.
    expect((await run("task_list", {})).content).toBe(
      "No background tasks.\nNo background subagents.",
    );
  });

  it("bash run_in_background returns a task id and registers the task", async () => {
    const res = await run("bash", {
      command: "node -e \"console.log('bg-out')\"",
      description: "print bg-out",
      run_in_background: true,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("Background task started: task-");
    expect(res.content).toContain("print bg-out");

    const id = res.content.match(/Background task started: (task-\d+)/)?.[1];
    expect(id).toBeDefined();
    const finished = await waitForTerminal(defaultTaskManager, id as string);
    expect(finished.status).toBe("completed");
    expect(finished.output).toContain("bg-out");
  });

  it("bash without run_in_background still runs in the foreground", async () => {
    const before = defaultTaskManager.list().length;
    const res = await run("bash", { command: "node -e \"console.log('fg-out')\"" });
    expect(res.content).toContain("fg-out");
    expect(defaultTaskManager.list()).toHaveLength(before);
  });

  it("task_list reports tasks with status and description", async () => {
    const started = defaultTaskManager.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      cwd,
      description: "sleeper",
    });
    const res = await run("task_list", {});
    expect(res.content).toContain(started.id);
    expect(res.content).toContain("running");
    expect(res.content).toContain("sleeper");
    defaultTaskManager.kill(started.id);
    const after = await run("task_list", {});
    expect(after.content).toContain("stopped");
  });

  it("task_output returns output for running and finished tasks", async () => {
    const res = await run("bash", {
      command: "node -e \"console.log('out-marker'); setTimeout(() => {}, 30000)\"",
      run_in_background: true,
    });
    const id = res.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const running = await run("task_output", { id });
    expect(running.content).toContain(id);
    expect(running.content).toContain("running");
    expect(running.content).toContain("out-marker");
    defaultTaskManager.kill(id);
    const stopped = await run("task_output", { id });
    expect(stopped.content).toContain("stopped");
  });

  it("task_output errors on unknown ids", async () => {
    const res = await run("task_output", { id: "task-999" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown task");
  });

  it("task_output truncates very long output to the 30KB tail", async () => {
    const res = await run("bash", {
      command: `node -e "process.stdout.write('z'.repeat(120000))"`,
      run_in_background: true,
    });
    const id = res.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    await waitForTerminal(defaultTaskManager, id);
    const out = await run("task_output", { id });
    expect(out.content).toContain("earlier output truncated; showing the last 30000 characters");
    const body = out.content.split("\n").slice(1).join("\n");
    expect(body.length).toBeLessThanOrEqual(30000 + 100);
  });

  it("task_kill stops a running task and rejects repeats", async () => {
    const started = defaultTaskManager.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      cwd,
    });
    const res = await run("task_kill", { id: started.id });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("stopped");
    expect(defaultTaskManager.get(started.id)?.status).toBe("stopped");

    const again = await run("task_kill", { id: started.id });
    expect(again.isError).toBe(true);
    expect(again.content).toContain("not running");

    const unknown = await run("task_kill", { id: "task-999" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("Unknown task");
  });
});
