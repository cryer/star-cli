import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/loader";
import { globalConfigPath } from "../src/config/paths";
import { addAllowRule } from "../src/config/save";
import { buildAllowRule, isAllowedByRules, parseAllowRule } from "../src/permissions/allow";
import { checkPermission } from "../src/permissions/gate";
import type { PermissionContext, PermissionRequest } from "../src/permissions/types";
import type { PermissionLevel } from "../src/tools/types";

const testCwd = path.join(path.parse(process.cwd()).root, "star_test_cwd");
const ctx: PermissionContext = { cwd: testCwd };

function req(toolName: string, args: unknown, level: PermissionLevel): PermissionRequest {
  return { toolName, args, level };
}

describe("parseAllowRule", () => {
  it("parses a bare tool rule", () => {
    expect(parseAllowRule("bash")).toEqual({ toolName: "bash", pattern: undefined });
  });

  it("parses a rule with an argument pattern", () => {
    expect(parseAllowRule("bash(git status *)")).toEqual({
      toolName: "bash",
      pattern: "git status *",
    });
  });

  it("keeps parentheses inside the pattern", () => {
    expect(parseAllowRule("bash(npm run build:(prod))")).toEqual({
      toolName: "bash",
      pattern: "npm run build:(prod)",
    });
  });

  it("rejects malformed rules", () => {
    expect(parseAllowRule("")).toBeNull();
    expect(parseAllowRule("(foo)")).toBeNull();
    expect(parseAllowRule("bash(foo")).toBeNull();
  });
});

describe("isAllowedByRules", () => {
  it("matches an exact command", () => {
    const request = req("bash", { command: "npm test" }, "exec");
    expect(isAllowedByRules(["bash(npm test)"], request)).toBe(true);
    expect(
      isAllowedByRules(["bash(npm test)"], req("bash", { command: "npm testx" }, "exec")),
    ).toBe(false);
  });

  it("matches * glob in the middle and at the end", () => {
    expect(
      isAllowedByRules(["bash(git status *)"], req("bash", { command: "git status -s" }, "exec")),
    ).toBe(true);
    expect(
      isAllowedByRules(
        ["bash(git * main)"],
        req("bash", { command: "git push origin main" }, "exec"),
      ),
    ).toBe(true);
    expect(
      isAllowedByRules(["bash(git status *)"], req("bash", { command: "git diff" }, "exec")),
    ).toBe(false);
  });

  it("treats * as matching an empty sequence", () => {
    expect(
      isAllowedByRules(["bash(git status*)"], req("bash", { command: "git status" }, "exec")),
    ).toBe(true);
  });

  it("matches a bare tool rule regardless of args", () => {
    expect(isAllowedByRules(["read_file"], req("read_file", { path: "a.ts" }, "read"))).toBe(true);
    expect(isAllowedByRules(["read_file"], req("write_file", { path: "a.ts" }, "write"))).toBe(
      false,
    );
  });

  it("matches file tools by path pattern", () => {
    expect(
      isAllowedByRules(["read_file(src/*)"], req("read_file", { path: "src/main.tsx" }, "read")),
    ).toBe(true);
    expect(
      isAllowedByRules(["read_file(src/*)"], req("read_file", { path: "dist/main.js" }, "read")),
    ).toBe(false);
  });

  it("does not match a patterned rule when the arg is missing", () => {
    expect(isAllowedByRules(["bash(npm test)"], req("bash", {}, "exec"))).toBe(false);
  });
});

describe("checkPermission with allow rules", () => {
  it("allows a matching rule in ask mode", () => {
    const request = req("bash", { command: "npm test" }, "exec");
    expect(checkPermission("ask", request, ctx, ["bash(npm test)"])).toBe("allow");
    expect(checkPermission("ask", request, ctx, [])).toBe("ask");
  });

  it("allows a matching glob rule for write_file in ask mode", () => {
    expect(
      checkPermission("ask", req("write_file", { path: "src/x.ts" }, "write"), ctx, [
        "write_file(src/*)",
      ]),
    ).toBe("allow");
  });

  it("does not let allow rules override readonly mode", () => {
    expect(
      checkPermission("readonly", req("write_file", { path: "src/x.ts" }, "write"), ctx, [
        "write_file",
      ]),
    ).toBe("deny");
  });

  it("does not let allow rules override dangerous bash commands", () => {
    for (const mode of ["auto", "ask", "readonly"] as const) {
      expect(
        checkPermission(mode, req("bash", { command: "rm -rf /" }, "exec"), ctx, [
          "bash(rm -rf /)",
          "bash",
        ]),
      ).toBe("deny");
    }
  });

  it("does not let allow rules override sensitive file protection", () => {
    expect(
      checkPermission("ask", req("write_file", { path: ".env" }, "write"), ctx, ["write_file"]),
    ).toBe("deny");
  });

  it("does not let allow rules override outside-cwd denies", () => {
    expect(
      checkPermission("ask", req("write_file", { path: "../x.ts" }, "write"), ctx, ["write_file"]),
    ).toBe("deny");
  });
});

describe("buildAllowRule", () => {
  it("uses the full bash command", () => {
    expect(buildAllowRule(req("bash", { command: "npm test" }, "exec"))).toBe("bash(npm test)");
  });

  it("uses the path for file tools", () => {
    expect(buildAllowRule(req("write_file", { path: "src/x.ts" }, "write"))).toBe(
      "write_file(src/x.ts)",
    );
  });

  it("falls back to the bare tool name without args", () => {
    expect(buildAllowRule(req("todo", {}, "write"))).toBe("todo");
  });
});

describe("addAllowRule persistence", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-cwd-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the rule to config.toml and reloads it", async () => {
    expect(await addAllowRule("bash(npm test)")).toBe(true);
    const config = await loadConfig(cwd);
    expect(config.permissions.allow).toEqual(["bash(npm test)"]);
  });

  it("dedupes rules and preserves other config keys", async () => {
    fs.writeFileSync(globalConfigPath(), 'defaultModel = "fast"\n');
    expect(await addAllowRule("bash(npm test)")).toBe(true);
    expect(await addAllowRule("bash(npm test)")).toBe(false);
    expect(await addAllowRule("read_file")).toBe(true);
    const config = await loadConfig(cwd);
    expect(config.defaultModel).toBe("fast");
    expect(config.permissions.allow).toEqual(["bash(npm test)", "read_file"]);
  });

  it("a persisted rule takes effect in checkPermission after reload", async () => {
    await addAllowRule("bash(git status *)");
    const config = await loadConfig(cwd);
    const request = req("bash", { command: "git status -s" }, "exec");
    expect(checkPermission(config.permissionMode, request, ctx, config.permissions.allow)).toBe(
      "allow",
    );
  });
});
