import type { LanguageModel } from "ai";
import { z } from "zod";
import type { StarConfig } from "../config/schema";
import type { PermissionRequest } from "../permissions/types";
import { createDefaultRegistry } from "../tools";
import type { Tool, ToolResult } from "../tools/types";
import { defaultAgentTasks } from "./agent-tasks";

// Subagents run one level deep: the child loop is created without the
// subagent tool, so a subagent can never spawn another subagent.
export const MAX_SUBAGENT_DEPTH = 1;

const MAX_REPORT_CHARS = 20_000;

const SUBAGENT_PROMPT =
  "You are a subagent spawned to handle a focused subtask on behalf of the main agent. Work autonomously with the tools available to you, then finish with a concise report of what you found or did. Your final text is returned to the main agent as the tool result — make it self-contained.";

export interface SubagentDeps {
  model: LanguageModel;
  config: StarConfig;
  cwd: string;
  system?: string;
  depth: number;
  getConfirmHandler?: () => ((req: PermissionRequest) => Promise<boolean>) | undefined;
}

interface SubagentArgs {
  prompt: string;
  description?: string;
}

// Runs a child loop to completion and returns its formatted report; the
// sync tool path and background agent tasks share this.
async function runSubagent(
  deps: SubagentDeps,
  args: SubagentArgs,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const { AgentLoop } = await import("./loop");
  const child = new AgentLoop({
    model: deps.model,
    registry: createDefaultRegistry(),
    config: deps.config,
    cwd,
    system: deps.system ? `${deps.system}\n\n${SUBAGENT_PROMPT}` : SUBAGENT_PROMPT,
    subagentDepth: deps.depth + 1,
  });
  const confirmHandler = deps.getConfirmHandler?.();
  if (confirmHandler) child.confirmHandler = confirmHandler;

  let toolCalls = 0;
  let error: string | null = null;
  try {
    for await (const event of child.stream(args.prompt, signal)) {
      if (event.type === "tool-result") {
        toolCalls++;
      } else if (event.type === "error") {
        error = event.error.message;
        break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // A user abort ends the child loop without an error event; surface it
  // through the same interrupted path as any other aborted tool instead of
  // returning a "successful" report that gets persisted as a normal result.
  if (signal.aborted) {
    throw new Error("Tool execution aborted.");
  }

  let report = "";
  const messages = child.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) {
      report = text;
      break;
    }
  }
  if (report.length > MAX_REPORT_CHARS) {
    report = `${report.slice(0, MAX_REPORT_CHARS)}\n... (truncated)`;
  }

  const label = args.description ? ` "${args.description}"` : "";
  const stats = `[subagent${label}: ${toolCalls} tool call(s)]`;
  if (error) {
    throw new Error([`Subagent failed: ${error}`, stats, report].filter(Boolean).join("\n"));
  }
  return `${stats}\n${report || "(subagent produced no text output)"}`;
}

export function createSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: "subagent",
    description:
      "Spawn a subagent with its own agent loop to handle a focused subtask (research, exploration, or an isolated change). The subagent has the same tools but cannot spawn further subagents. Returns the subagent's final report. Prefer this for self-contained work that would otherwise clutter the main conversation. Set run_in_background to start it without blocking: independent subtasks then run concurrently and their reports are delivered to you automatically when they finish (also inspectable via task_list/task_output/task_kill).",
    permission: "exec",
    parameters: z.object({
      prompt: z.string().describe("Complete, self-contained instructions for the subagent."),
      description: z
        .string()
        .optional()
        .describe("Short label for the subtask, shown in the result header."),
      run_in_background: z
        .boolean()
        .optional()
        .describe(
          "Run concurrently in the background and return a task id immediately (default false). Use for independent subtasks that can run in parallel.",
        ),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      if (args.run_in_background) {
        const task = defaultAgentTasks.start((signal) => runSubagent(deps, args, ctx.cwd, signal), {
          prompt: args.prompt,
          description: args.description,
        });
        const label = args.description ? ` "${args.description}"` : "";
        return {
          content: `Background subagent ${task.id}${label} started. Its report will be delivered as a message when it finishes; use task_list/task_output to check progress.`,
        };
      }

      const signal = ctx.abortSignal ?? new AbortController().signal;
      try {
        return { content: await runSubagent(deps, args, ctx.cwd, signal) };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}
