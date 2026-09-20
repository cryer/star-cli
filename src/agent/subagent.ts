import type { LanguageModel } from "ai";
import { z } from "zod";
import type { StarConfig } from "../config/schema";
import type { PermissionRequest } from "../permissions/types";
import { createDefaultRegistry } from "../tools";
import type { Tool, ToolResult } from "../tools/types";

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

export function createSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: "subagent",
    description:
      "Spawn a subagent with its own agent loop to handle a focused subtask (research, exploration, or an isolated change). The subagent has the same tools but cannot spawn further subagents. Returns the subagent's final report. Prefer this for self-contained work that would otherwise clutter the main conversation.",
    permission: "exec",
    parameters: z.object({
      prompt: z.string().describe("Complete, self-contained instructions for the subagent."),
      description: z
        .string()
        .optional()
        .describe("Short label for the subtask, shown in the result header."),
    }),
    async execute(args, ctx): Promise<ToolResult> {
      const { AgentLoop } = await import("./loop");
      const child = new AgentLoop({
        model: deps.model,
        registry: createDefaultRegistry(),
        config: deps.config,
        cwd: ctx.cwd,
        system: deps.system ? `${deps.system}\n\n${SUBAGENT_PROMPT}` : SUBAGENT_PROMPT,
        subagentDepth: deps.depth + 1,
      });
      const confirmHandler = deps.getConfirmHandler?.();
      if (confirmHandler) child.confirmHandler = confirmHandler;

      const signal = ctx.abortSignal ?? new AbortController().signal;
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
        return {
          content: [`Subagent failed: ${error}`, stats, report].filter(Boolean).join("\n"),
          isError: true,
        };
      }
      return { content: `${stats}\n${report || "(subagent produced no text output)"}` };
    },
  };
}
