import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPermission, describeDecision } from "../src/permissions/gate";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "../src/permissions/types";
import type { PermissionLevel } from "../src/tools/types";

const testCwd = path.join(path.parse(process.cwd()).root, "star_test_cwd");
const ctx: PermissionContext = { cwd: testCwd };

function req(toolName: string, args: unknown, level: PermissionLevel): PermissionRequest {
  return { toolName, args, level };
}

describe("mode × level matrix (safe requests)", () => {
  const cases: Array<[PermissionMode, PermissionLevel, PermissionDecision]> = [
    ["auto", "read", "allow"],
    ["auto", "write", "allow"],
    ["auto", "exec", "allow"],
    ["readonly", "read", "allow"],
    ["readonly", "write", "deny"],
    ["readonly", "exec", "deny"],
    ["ask", "read", "allow"],
    ["ask", "write", "ask"],
    ["ask", "exec", "ask"],
    ["plan", "read", "allow"],
    ["plan", "write", "deny"],
    ["plan", "exec", "deny"],
  ];
  for (const [mode, level, expected] of cases) {
    it(`${mode} + ${level} -> ${expected}`, () => {
      const toolName = level === "exec" ? "bash" : level === "write" ? "write_file" : "read_file";
      const args = level === "exec" ? { command: "ls" } : { path: "src/main.tsx" };
      expect(checkPermission(mode, req(toolName, args, level), ctx)).toBe(expected);
    });
  }
});

describe("dangerous bash commands", () => {
  const dangerous = [
    "rm -rf /",
    "rm -rf / ",
    "sudo rm -rf ~",
    "rm -rf ~/",
    ":(){ :|:& };:",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "cat x > /dev/sda",
    "shutdown -h now",
    "reboot",
    "poweroff",
  ];
  const modes: PermissionMode[] = ["auto", "ask", "readonly"];
  for (const command of dangerous) {
    for (const mode of modes) {
      it(`denies "${command}" in ${mode} mode`, () => {
        expect(checkPermission(mode, req("bash", { command }, "exec"), ctx)).toBe("deny");
      });
    }
  }

  it("allows safe commands", () => {
    for (const command of [
      "ls -la",
      "rm -rf node_modules",
      "git status",
      "rm -rf /home/user/tmp",
    ]) {
      expect(checkPermission("auto", req("bash", { command }, "exec"), ctx)).toBe("allow");
    }
  });
});

describe("path outside cwd", () => {
  it("denies ../ escape for write in auto mode", () => {
    expect(
      checkPermission("auto", req("write_file", { path: "../secret.txt" }, "write"), ctx),
    ).toBe("deny");
  });

  it("denies absolute path outside cwd in auto mode", () => {
    const outsideAbs =
      process.platform === "win32" ? "C:/Windows/system32/x.dll" : "/etc/star_outside/x.dll";
    expect(checkPermission("auto", req("write_file", { path: outsideAbs }, "write"), ctx)).toBe(
      "deny",
    );
  });

  it("denies outside read in auto mode", () => {
    expect(
      checkPermission("auto", req("read_file", { path: "../../other/file.txt" }, "read"), ctx),
    ).toBe("deny");
  });

  it("asks for outside read in ask mode, denies outside write", () => {
    expect(checkPermission("ask", req("read_file", { path: "../outside.txt" }, "read"), ctx)).toBe(
      "ask",
    );
    expect(checkPermission("ask", req("edit_file", { path: "../outside.txt" }, "write"), ctx)).toBe(
      "deny",
    );
  });

  it("denies outside write in readonly mode", () => {
    expect(
      checkPermission("readonly", req("write_file", { path: "../outside.txt" }, "write"), ctx),
    ).toBe("deny");
  });

  it("denies outside read in plan mode", () => {
    expect(checkPermission("plan", req("read_file", { path: "../outside.txt" }, "read"), ctx)).toBe(
      "deny",
    );
  });

  it("allows paths inside cwd", () => {
    expect(
      checkPermission("auto", req("write_file", { path: "src/new-file.ts" }, "write"), ctx),
    ).toBe("allow");
    expect(
      checkPermission(
        "auto",
        req("write_file", { path: path.join(testCwd, "dist", "out.js") }, "write"),
        ctx,
      ),
    ).toBe("allow");
  });

  it.runIf(process.platform === "win32")("compares drive letters case-insensitively", () => {
    const upperCtx: PermissionContext = { cwd: "e:/star_cli" };
    expect(
      checkPermission(
        "auto",
        req("write_file", { path: "E:/STAR_CLI/src/x.ts" }, "write"),
        upperCtx,
      ),
    ).toBe("allow");
    expect(
      checkPermission("auto", req("read_file", { path: "D:/other/x.ts" }, "read"), upperCtx),
    ).toBe("deny");
  });

  it.runIf(process.platform === "win32")("normalizes backslashes and .. segments", () => {
    expect(
      checkPermission("auto", req("read_file", { path: "src\\..\\..\\escape.txt" }, "read"), ctx),
    ).toBe("deny");
  });
});

describe("sensitive files", () => {
  const sensitive = [".env", ".env.local", ".env.production", "id_rsa", "certs/server.pem"];
  for (const file of sensitive) {
    for (const toolName of ["write_file", "edit_file"]) {
      it(`denies ${toolName} on ${file} in ask/auto/readonly modes`, () => {
        for (const mode of ["auto", "ask", "readonly"] as const) {
          expect(checkPermission(mode, req(toolName, { path: file }, "write"), ctx)).toBe("deny");
        }
      });
    }
  }

  it("allows .env.example / .env.sample / .env.template", () => {
    for (const file of [".env.example", ".env.sample", ".env.template"]) {
      expect(checkPermission("auto", req("write_file", { path: file }, "write"), ctx)).toBe(
        "allow",
      );
    }
  });
});

describe("yolo mode", () => {
  it("allows everything without asking, including hard-denied operations", () => {
    expect(checkPermission("yolo", req("bash", { command: "rm -rf /" }, "exec"), ctx)).toBe(
      "allow",
    );
    expect(checkPermission("yolo", req("bash", { command: "shutdown now" }, "exec"), ctx)).toBe(
      "allow",
    );
    expect(checkPermission("yolo", req("write_file", { path: ".env" }, "write"), ctx)).toBe(
      "allow",
    );
    expect(
      checkPermission("yolo", req("write_file", { path: "../outside.txt" }, "write"), ctx),
    ).toBe("allow");
    expect(checkPermission("yolo", req("read_file", { path: "x.ts" }, "read"), ctx)).toBe("allow");
  });
});

describe("describeDecision", () => {
  it("returns a short Chinese description for each decision", () => {
    expect(describeDecision("allow")).toContain("允许");
    expect(describeDecision("deny")).toContain("拒绝");
    expect(describeDecision("ask")).toContain("确认");
  });
});
