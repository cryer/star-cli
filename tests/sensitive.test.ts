import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitivePath, registerSensitivePatterns } from "../src/core/sensitive";
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
