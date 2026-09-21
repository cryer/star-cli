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
  permissions: PermissionsConfigSchema.default({ allow: [] }),
  hooks: z.array(HookConfigSchema).default([]),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type HookConfig = z.infer<typeof HookConfigSchema>;
export type StarConfig = z.infer<typeof ConfigSchema>;

export interface CliOverrides {
  model?: string;
  permissionMode?: "auto" | "ask" | "readonly" | "yolo" | "plan";
}
