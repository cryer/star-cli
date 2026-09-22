import { z } from "zod";

export const ProviderConfigSchema = z.object({
  name: z.string(),
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
  // Cost estimation needs BOTH prices (USD per 1M tokens); with only one set
  // the model is treated as unpriced.
  promptPrice: z.number().nonnegative().optional(),
  completionPrice: z.number().nonnegative().optional(),
});

export const PermissionsConfigSchema = z.object({
  allow: z.array(z.string()).default([]),
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
  maxSteps: z.number().int().positive().default(50),
  contextMaxTokens: z.number().int().positive().default(100_000),
  // Seconds without any stream part before a stalled response is ended
  // gracefully (some relays never send the terminal chunks). Applies once
  // streaming has started; the first part gets a longer, fixed allowance.
  streamIdleTimeoutSec: z.number().positive().default(20),
  contextCompaction: z.enum(["summary", "truncate"]).default("summary"),
  // Optional per-session dollar budget; when set, the REPL stops the session
  // once the estimated cost for the session reaches this amount.
  sessionBudgetUsd: z.number().positive().optional(),
  // Terminal bell (REPL only): ring when a turn takes longer than
  // notifyBellThresholdSec, and when a background task finishes.
  // STAR_NO_NOTIFY=1 disables without touching the config.
  notifyBell: z.boolean().default(true),
  notifyBellThresholdSec: z.number().positive().default(10),
  permissions: PermissionsConfigSchema.default({ allow: [] }),
  hooks: z.array(HookConfigSchema).default([]),
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

export interface CliOverrides {
  model?: string;
  permissionMode?: "auto" | "ask" | "readonly" | "yolo" | "plan";
}
