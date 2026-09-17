import type { LanguageModel } from "ai";
import { tool as aiTool } from "ai";
import type { StarConfig } from "../config/schema";
import { compactMessages } from "../context/compaction";
import type { StreamEvent } from "../core/events";
import type { CoreMessage } from "../core/messages";
import { checkPermission } from "../permissions/gate";
import type { PermissionRequest } from "../permissions/types";
import type { SessionStore } from "../session/store";
import type { ToolRegistry } from "../tools/registry";
import type { ToolResult } from "../tools/types";

export interface AgentLoopOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  config: StarConfig;
  cwd: string;
  system?: string;
  sessionStore?: SessionStore | null;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

export class AgentLoop {
  private messages: CoreMessage[] = [];
  private readonly opts: AgentLoopOptions;
  confirmHandler?: (req: PermissionRequest) => Promise<boolean>;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
    if (opts.system) {
      this.messages.push({ role: "system", content: opts.system });
    }
  }

  getMessages(): readonly CoreMessage[] {
    return this.messages;
  }

  async loadMessages(messages: CoreMessage[]): Promise<void> {
    this.messages = messages;
  }

  private async persist(message: CoreMessage): Promise<void> {
    await this.opts.sessionStore?.append(message);
  }

  async *stream(input: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const userMessage: CoreMessage = { role: "user", content: input };
    this.messages.push(userMessage);
    await this.persist(userMessage);

    const { config, registry, cwd } = this.opts;
    const aiTools = this.buildAiTools();

    for (let step = 0; step < config.maxSteps; step++) {
      const compacted = compactMessages([...this.messages], config.contextMaxTokens);
      if (compacted.compacted) {
        this.messages = compacted.messages;
      }

      let text = "";
      const toolCalls: PendingToolCall[] = [];
      let failed = false;

      try {
        for await (const event of this.streamOnce(aiTools, signal)) {
          if (event.type === "text-delta") {
            text += event.text;
            yield event;
          } else if (event.type === "tool-call") {
            toolCalls.push({ id: event.id, name: event.name, args: event.args });
            yield event;
          } else if (event.type === "error") {
            failed = true;
            yield event;
          } else {
            yield event;
          }
        }
      } catch (error) {
        yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }

      if (failed) return;

      const assistantMessage: CoreMessage = {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            args: call.args,
          })),
        ],
      };
      this.messages.push(assistantMessage);
      await this.persist(assistantMessage);

      if (toolCalls.length === 0) return;

      for (const call of toolCalls) {
        const result = await this.executeTool(call, signal);
        const toolMessage: CoreMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              result: result.content,
            },
          ],
        };
        this.messages.push(toolMessage);
        await this.persist(toolMessage);
        yield {
          type: "tool-result",
          id: call.id,
          name: call.name,
          content: result.content,
          isError: result.isError,
        };
      }
    }

    yield {
      type: "error",
      error: new Error(`Max steps (${config.maxSteps}) reached, stopping.`),
    };
  }

  private async *streamOnce(
    aiTools: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const { streamChat } = await import("../llm/stream");
    yield* streamChat({
      model: this.opts.model,
      messages: this.messages,
      tools: aiTools,
      abortSignal: signal,
    });
  }

  private buildAiTools(): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const t of this.opts.registry.list()) {
      tools[t.name] = aiTool({
        description: t.description,
        parameters: t.parameters as never,
      });
    }
    return tools;
  }

  private async executeTool(call: PendingToolCall, signal: AbortSignal): Promise<ToolResult> {
    const { registry, config, cwd } = this.opts;
    const tool = registry.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    const decision = checkPermission(
      config.permissionMode,
      { toolName: call.name, args: call.args, level: tool.permission },
      { cwd },
    );

    if (decision === "deny") {
      return { content: `Permission denied for tool "${call.name}".`, isError: true };
    }
    if (decision === "ask") {
      const approved = this.confirmHandler
        ? await this.confirmHandler({
            toolName: call.name,
            args: call.args,
            level: tool.permission,
          })
        : false;
      if (!approved) {
        return { content: `User rejected tool "${call.name}".`, isError: true };
      }
    }

    const parsed = tool.parameters.safeParse(call.args);
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true };
    }

    try {
      return await tool.execute(parsed.data, { cwd, abortSignal: signal });
    } catch (error) {
      if (signal.aborted) {
        return { content: "Tool execution aborted.", isError: true };
      }
      return {
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
