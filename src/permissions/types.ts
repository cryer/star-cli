import type { PermissionLevel } from "../tools/types";

export type PermissionMode = "auto" | "ask" | "readonly" | "yolo" | "plan";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRequest {
  toolName: string;
  args: unknown;
  level: PermissionLevel;
}

export interface PermissionContext {
  cwd: string;
}
