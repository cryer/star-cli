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
});

export const PermissionsConfigSchema = z.object({
  allow: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  defaultModel: z.string().default(""),
  permissionMode: z.enum(["auto", "ask", "readonly"]).default("ask"),
  providers: z.array(ProviderConfigSchema).default([]),
  models: z.array(ModelConfigSchema).default([]),
  maxSteps: z.number().int().positive().default(50),
  contextMaxTokens: z.number().int().positive().default(100_000),
  contextCompaction: z.enum(["summary", "truncate"]).default("summary"),
  permissions: PermissionsConfigSchema.default({ allow: [] }),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type StarConfig = z.infer<typeof ConfigSchema>;

export interface CliOverrides {
  model?: string;
  permissionMode?: "auto" | "ask" | "readonly";
}
