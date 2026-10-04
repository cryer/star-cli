import type { LanguageModel } from "ai";
import { z } from "zod";
import type { StarConfig } from "../config/schema";
import type { TokenUsage } from "../core/events";
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
  // Inherited from the parent loop so the child requests carry the same
  // provider metadata (reasoningEffort).
  providerMetadata?: Record<string, Record<string, unknown>>;
  // Inherited from the parent loop (the model's [[models]] temperature key).
  temperature?: number;
  // Inherited from the parent loop (the model's [[models]] stream watchdog
  // overrides); unset falls back to the top-level config values.
  streamIdleTimeoutSec?: number;
  streamFirstChunkTimeoutSec?: number;
  // Inherited from the parent loop (the model's [[models]] vision key); when
  // false the child's read_image/screenshot decline with a text error too.
  vision?: boolean;
  depth: number;
  getConfirmHandler?: () => ((req: PermissionRequest) => Promise<boolean>) | undefined;
  // Receives the child loop's accumulated token usage once the run settles
  // (sync or background, success or failure), along with the model the
  // child ran on. The parent loop folds it into its own finish events, so
  // subagent spend flows into /cost, /usage and sessionBudgetUsd without
  // those consumers changing.
  onUsage?: (usage: TokenUsage, model: LanguageModel) => void;
}

interface SubagentArgs {
  prompt: string;
  description?: string;
}

// Session cost is computed by the consumers as token totals × the *active*
// model's price (cli/cost.ts computeCostUsd, over the session usage built
// from root-loop finish events). Folding a child's tokens straight into the
// parent's totals would misprice them when the child ran on a differently
// priced model, so each priced token class is converted into the number of
// parent-priced tokens that bills the same dollars. A child on the same
// model (the common case) short-circuits to the exact counts; when either
// side lacks full pricing (or the parent prices a class at 0, making
// dollars inexpressible as tokens) the raw counts pass through — the same
// approximation the session total already makes.
export function convertUsagePricing(
  usage: TokenUsage,
  from: LanguageModel,
  to: LanguageModel,
  config: StarConfig,
): TokenUsage {
  if (from === to) return usage;
  const fromCfg = config.models.find((m) => m.model === from.modelId);
  const toCfg = config.models.find((m) => m.model === to.modelId);
  if (
    fromCfg?.promptPrice === undefined ||
    fromCfg.completionPrice === undefined ||
    toCfg?.promptPrice === undefined ||
    toCfg.completionPrice === undefined ||
    toCfg.promptPrice <= 0 ||
    toCfg.completionPrice <= 0
  ) {
    return usage;
  }
  // Dollars per token class under the child's pricing, mirroring
  // computeCostUsd's cache rules (cached prompt tokens are a subset billed
  // at cacheReadPrice ?? promptPrice; Anthropic-style cache reads come on
  // top at cacheReadPrice ?? 0). The per-million divisor cancels in the
  // ratio, so prices are used as-is.
  const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), usage.promptTokens);
  const promptUsd = (usage.promptTokens - cached) * fromCfg.promptPrice;
  const cachedUsd = cached * (fromCfg.cacheReadPrice ?? fromCfg.promptPrice);
  const cacheReadUsd = (usage.cacheReadInputTokens ?? 0) * (fromCfg.cacheReadPrice ?? 0);
  const completionUsd = usage.completionTokens * fromCfg.completionPrice;

  const scaledCached = cachedUsd / (toCfg.cacheReadPrice ?? toCfg.promptPrice);
  const promptTokens = Math.round(promptUsd / toCfg.promptPrice + scaledCached);
  const cachedPromptTokens = Math.round(scaledCached);
  // A parent without a cache-read price bills that class at 0, so its
  // dollars ride on the completion class instead of being dropped.
  const toCacheReadPrice =
    toCfg.cacheReadPrice !== undefined && toCfg.cacheReadPrice > 0
      ? toCfg.cacheReadPrice
      : undefined;
  const completionTokens = Math.round(
    completionUsd / toCfg.completionPrice +
      (toCacheReadPrice === undefined ? cacheReadUsd / toCfg.completionPrice : 0),
  );
  const cacheReadInputTokens =
    toCacheReadPrice === undefined ? 0 : Math.round(cacheReadUsd / toCacheReadPrice);
  const result: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
  if (cachedPromptTokens > 0) result.cachedPromptTokens = cachedPromptTokens;
  if (cacheReadInputTokens > 0) result.cacheReadInputTokens = cacheReadInputTokens;
  return result;
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
    providerMetadata: deps.providerMetadata,
    temperature: deps.temperature,
    streamIdleTimeoutSec: deps.streamIdleTimeoutSec,
    streamFirstChunkTimeoutSec: deps.streamFirstChunkTimeoutSec,
    vision: deps.vision,
    subagentDepth: deps.depth + 1,
  });
  const confirmHandler = deps.getConfirmHandler?.();
  if (confirmHandler) child.confirmHandler = confirmHandler;

  let toolCalls = 0;
  let error: string | null = null;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  try {
    for await (const event of child.stream(args.prompt, signal)) {
      if (event.type === "tool-result") {
        toolCalls++;
      } else if (event.type === "error") {
        error = event.error.message;
        break;
      } else if (event.type === "finish" && event.usage) {
        usage.promptTokens += event.usage.promptTokens;
        usage.completionTokens += event.usage.completionTokens;
        usage.totalTokens += event.usage.totalTokens;
        usage.cachedPromptTokens =
          (usage.cachedPromptTokens ?? 0) + (event.usage.cachedPromptTokens ?? 0);
        usage.cacheReadInputTokens =
          (usage.cacheReadInputTokens ?? 0) + (event.usage.cacheReadInputTokens ?? 0);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    // The child spent tokens even when it errored or was aborted — report
    // whatever accumulated so the parent can bill it.
    if (usage.totalTokens > 0) deps.onUsage?.(usage, deps.model);
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
