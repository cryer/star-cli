import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSecretEnvName, isSensitivePath, registerSensitivePatterns } from "../src/core/sensitive";
import { checkPermission } from "../src/permissions/gate";
import type { PermissionContext, PermissionRequest } from "../src/permissions/types";

const ctx: PermissionContext = { cwd: path.join(path.parse(process.cwd()).root, "star_test_cwd") };

function req(toolName: string, args: unknown, level: "read" | "write" | "exec"): PermissionRequest {
  return { toolName, args, level };
}

afterEach(() => {
  registerSensitivePatterns([]);
});

describe("isSensitivePath builtins", () => {
  it("flags well-known secret files and spares env templates", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.production")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("cert/server.pem")).toBe(true);
    expect(isSensitivePath(".aws/credentials")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("src/main.ts")).toBe(false);
  });
});

describe("isSecretEnvName", () => {
  it("flags well-known secret variable names, case-insensitively", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "anthropic_api_key",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AZURE_CLIENT_SECRET",
      "DATABASE_PASSWORD",
      "PGPASSWORD",
      "MY_LLM_KEY",
      "NPM_TOKEN",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("spares ordinary and allowlisted variables", () => {
    for (const name of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "NODE_ENV",
      "SSH_AUTH_SOCK",
      "GPG_TTY",
      "MONKEY",
      "HOTKEY",
      "TOKENIZERS_PARALLELISM",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AWS_SHARED_CREDENTIALS_FILE",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});

describe("registerSensitivePatterns", () => {
  it("matches extra globs against the basename, case-insensitively", () => {
    registerSensitivePatterns(["*.secret"]);
    expect(isSensitivePath("x.secret")).toBe(true);
    expect(isSensitivePath("dir/BACKUP.SECRET")).toBe(true);
    expect(isSensitivePath("x.secret.bak")).toBe(false);
    expect(isSensitivePath("x.txt")).toBe(false);
  });

  it("matches extra globs against the full normalized path", () => {
    registerSensitivePatterns(["vault/*"]);
    expect(isSensitivePath("vault/key.txt")).toBe(true);
    expect(isSensitivePath("vault\\key.txt")).toBe(true);
    // Anchored like permission-rule globs: no implicit ** prefix.
    expect(isSensitivePath("src/vault/key.txt")).toBe(false);
    registerSensitivePatterns(["*vault*"]);
    expect(isSensitivePath("src/vault/key.txt")).toBe(true);
  });

  it("replaces the set wholesale on every call", () => {
    registerSensitivePatterns(["a/*"]);
    expect(isSensitivePath("a/x")).toBe(true);
    registerSensitivePatterns(["b/*"]);
    expect(isSensitivePath("a/x")).toBe(false);
    expect(isSensitivePath("b/x")).toBe(true);
    registerSensitivePatterns([]);
    expect(isSensitivePath("b/x")).toBe(false);
  });

  it("lets an explicit glob override the env-template exemption", () => {
    expect(isSensitivePath(".env.example")).toBe(false);
    registerSensitivePatterns([".env.example"]);
    expect(isSensitivePath(".env.example")).toBe(true);
  });

  it("extends the write-tool deny in checkPermission", () => {
    registerSensitivePatterns(["*.secret"]);
    expect(checkPermission("auto", req("write_file", { path: "x.secret" }, "write"), ctx)).toBe(
      "deny",
    );
    expect(checkPermission("auto", req("write_file", { path: "x.txt" }, "write"), ctx)).toBe(
      "allow",
    );
  });
});
