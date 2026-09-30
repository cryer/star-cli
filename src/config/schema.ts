import { z } from "zod";

export const ProviderConfigSchema = z.object({
  name: z.string(),
  // openai-responses talks to the Responses API (/responses) instead of chat
  // completions — the wire format codex uses, and the native API of
  // reasoning-model relays that otherwise hide reasoning behind empty chat
  // completions. streamChat sends strictSchemas:false + store:false with it.
  protocol: z
    .enum(["openai-compatible", "anthropic", "openai-responses"])
    .default("openai-compatible"),
  baseURL: z.string(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export const ModelConfigSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().int().positive().optional(),
  // Per-model context window; overrides the top-level contextMaxTokens for
  // compaction and the status bar when set.
  contextMaxTokens: z.number().int().positive().optional(),
  // Reasoning intensity for thinking models, forwarded verbatim as
  // OpenAI-style reasoning_effort on every request (llm/provider.ts
  // reasoningEffortMetadata) — level naming varies by model/provider
  // (low|medium|high are common; some add minimal/max/xhigh/none), so any
  // non-empty string is accepted and the server validates it. Unset = the
  // request carries no effort field and the server-side default applies.
  // Anthropic maps effort to a thinking budget instead — ignored there.
  reasoningEffort: z.string().min(1).optional(),
  // Sampling temperature forwarded on every request. Unset = the AI SDK's
  // own default applies (ai@4 sends 0 — it does NOT omit the field). Some
  // endpoints reject anything but one explicit value (e.g. kimi-for-coding:
  // "invalid temperature: only 1 is allowed") — set it here. No upper
  // bound: ranges vary by provider and the server validates.
  temperature: z.number().min(0).optional(),
  // Per-model overrides of the top-level stream watchdog timeouts (unset =
  // the global values apply). Raise streamIdleTimeoutSec for relays that
  // buffer long generations and stall mid-stream between flushes.
  streamIdleTimeoutSec: z.number().positive().optional(),
  streamFirstChunkTimeoutSec: z.number().positive().optional(),
  // Cost estimation needs BOTH prices (USD per 1M tokens); with only one set
  // the model is treated as unpriced.
  promptPrice: z.number().nonnegative().optional(),
  completionPrice: z.number().nonnegative().optional(),
  // Optional price (USD per 1M tokens) for cache-read prompt tokens. When
  // unset, OpenAI-style cached tokens bill at promptPrice and Anthropic-style
  // cache reads are not billed — set this for accurate cache pricing.
  cacheReadPrice: z.number().nonnegative().optional(),
});

export const PermissionsConfigSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

export const HookConfigSchema = z.object({
  event: z.enum(["PreToolUse", "PostToolUse", "Stop"]),
  matcher: z
    .string()
    .refine(
      (pattern) => {
        try {
          new RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      },
      { message: "invalid regular expression" },
    )
    .optional(),
  command: z.string().min(1),
  timeoutSec: z.number().positive().default(30),
});

export const ConfigSchema = z.object({
  defaultModel: z.string().default(""),
  permissionMode: z.enum(["auto", "ask", "readonly", "yolo", "plan"]).default("ask"),
  providers: z.array(ProviderConfigSchema).default([]),
  models: z.array(ModelConfigSchema).default([]),
  // Cap on model round-trips ("steps") per turn between progress checkpoints.
  // One step is a streamed reply plus every tool call it asked for — stream
  // retries and auto-continue nudges do not consume steps. Reaching the cap
  // while tools still execute resets the budget with a notice; the turn stops
  // only when no tool ran since the last checkpoint (the doom-loop
  // signature). 0 disables the cap entirely (opencode/codex have none).
  maxSteps: z.number().int().min(0).default(100),
  contextMaxTokens: z.number().int().positive().default(100_000),
  // Token threshold at which the agent loop auto-compacts the history.
  // Defaults to the effective context window (compact only when full); set a
  // lower value to compact earlier and keep headroom. Manual /compact ignores
  // this — it always compacts.
  compactThresholdTokens: z.number().int().positive().optional(),
  // Seconds without any stream part before a stalled response is ended
  // gracefully (some relays never send the terminal chunks). Applies once
  // content has started streaming; the wait for the first content part gets
  // a longer allowance (control/metadata parts don't count as content).
  streamIdleTimeoutSec: z.number().positive().default(20),
  // Seconds to wait for the very first content part before giving up; slow
  // thinking-model endpoints can stay silent for minutes after accepting
  // the request.
  streamFirstChunkTimeoutSec: z.number().positive().default(300),
  // Extra attempts per model request when a stream fails transiently
  // (network error, 429/5xx, idle watchdog cutoff) or comes back empty, so a
  // relay hiccup does not silently end a half-finished turn. 0 disables.
  // The wait between attempts honors Retry-After headers and otherwise backs
  // off exponentially with jitter (llm/retry.ts); retries after a
  // timeout/empty failure also scale both stream timeouts up (attempt number
  // ×, capped at 3x) since the relay is likely overloaded. Default 5 matches
  // opencode/Codex retry budgets and rides out flaky relays (中转站) better
  // than a minimal budget.
  streamMaxRetries: z.number().int().min(0).default(5),
  // How many consecutive unproductive replies may be nudged before the turn
  // is handed back: a text-only reply that announces pending work ("我将…",
  // "I will…") or answers a nudge with more words, or an empty reply that
  // survived the stream retry budget (steered with a nudge — a changed
  // request — since identical resends already failed). Tool calls reset the
  // count, so a productive task keeps going; exhaustion surfaces a notice
  // instead of stopping silently. Never fires in plan mode. 0 disables.
  maxAutoContinues: z.number().int().min(0).default(2),
  contextCompaction: z.enum(["summary", "truncate"]).default("summary"),
  // Optional per-session dollar budget; when set, the REPL stops the session
  // once the estimated cost for the session reaches this amount.
  sessionBudgetUsd: z.number().positive().optional(),
  // Terminal bell (REPL only): ring when a turn takes longer than
  // notifyBellThresholdSec, and when a background task finishes.
  // STAR_NO_NOTIFY=1 disables without touching the config.
  notifyBell: z.boolean().default(true),
  notifyBellThresholdSec: z.number().positive().default(10),
  permissions: PermissionsConfigSchema.default({ allow: [], deny: [] }),
  hooks: z.array(HookConfigSchema).default([]),
  // Consecutive identical tool calls (same tool + same arguments) allowed
  // before the loop refuses to execute the repeat and tells the model to
  // change approach — a guard against agents stuck retrying a failing call
  // (opencode's doom_loop). 0 disables.
  doomLoopThreshold: z.number().int().min(0).default(3),
  // Track the whole working tree with an internal git repo (outside the
  // user's .git) at every turn boundary, so /undo and /redo can restore
  // changes made by ANY tool (bash included), not just write_file/edit_file.
  // Falls back silently to per-file snapshots when git is unavailable.
  gitSnapshots: z.boolean().default(true),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type HookConfig = z.infer<typeof HookConfigSchema>;
export type StarConfig = z.infer<typeof ConfigSchema>;

// Effective context window for a model: its own contextMaxTokens when set,
// otherwise the top-level config.contextMaxTokens.
export function contextWindowTokens(config: StarConfig, modelName: string): number {
  return (
    config.models.find((m) => m.name === modelName)?.contextMaxTokens ?? config.contextMaxTokens
  );
}

// Token threshold that triggers automatic compaction in the agent loop:
// config.compactThresholdTokens when set, clamped to the window so a stale
// value (e.g. after switching to a smaller model) never pushes compaction
// past it; otherwise the window itself (current behavior).
export function resolveCompactThreshold(config: StarConfig, windowTokens: number): number {
  return Math.min(config.compactThresholdTokens ?? windowTokens, windowTokens);
}

export interface CliOverrides {
  model?: string;
  permissionMode?: "auto" | "ask" | "readonly" | "yolo" | "plan";
}
