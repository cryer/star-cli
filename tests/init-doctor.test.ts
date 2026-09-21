import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type DoctorCheck, formatDoctorReport, runDoctor } from "../src/cli/commands/doctor";
import { initProject, renderAgentsMd, scanProject } from "../src/cli/commands/init-project";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import type { StarConfig } from "../src/config/schema";

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "main",
    permissionMode: "auto",
    providers: [
      {
        name: "openai",
        protocol: "openai-compatible",
        baseURL: "https://api.example.com/v1",
        apiKeyEnv: "TEST_PROVIDER_KEY",
      },
    ],
    models: [{ name: "main", provider: "openai", model: "gpt-test" }],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    permissions: { allow: [] },
    hooks: [],
    ...overrides,
  };
}

function makeFakeProject(cwd: string) {
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "fake-project",
      scripts: { test: "vitest run", build: "tsup", lint: "biome check ." },
      dependencies: { ink: "^5.0.0", zod: "^3.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
  );
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fake Project\n\nA fake project for tests.\n");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, "node_modules"));
}

describe("/init", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-init-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe("scanProject", () => {
    it("collects facts from a fake project", async () => {
      makeFakeProject(cwd);
      const facts = await scanProject(cwd);

      expect(facts.name).toBe("fake-project");
      expect(facts.packageManager).toBe("pnpm");
      expect(facts.scripts.test).toBe("vitest run");
      expect(facts.dependencies).toEqual(["ink", "zod"]);
      expect(facts.devDependencies).toEqual(["typescript"]);
      expect(facts.commands).toEqual({
        test: "pnpm test",
        build: "pnpm build",
        lint: "pnpm lint",
        typecheck: null,
      });
      expect(facts.hasTsconfig).toBe(true);
      expect(facts.isGitRepo).toBe(true);
      expect(facts.readmeHead).toEqual(["# Fake Project", "A fake project for tests."]);
      expect(facts.entries).toContain("src/");
      expect(facts.entries).toContain("package.json");
      expect(facts.entries).not.toContain("node_modules/");
      expect(facts.entries).not.toContain(".git/");
    });

    it("handles an empty directory", async () => {
      const facts = await scanProject(cwd);

      expect(facts.name).toBeNull();
      expect(facts.packageManager).toBeNull();
      expect(facts.commands.test).toBeNull();
      expect(facts.hasTsconfig).toBe(false);
      expect(facts.isGitRepo).toBe(false);
      expect(facts.readmeHead).toEqual([]);
      expect(facts.entries).toEqual([]);
    });
  });

  describe("renderAgentsMd", () => {
    it("renders Project / Commands / Layout / Conventions sections", async () => {
      makeFakeProject(cwd);
      const markdown = renderAgentsMd(await scanProject(cwd));

      expect(markdown).toContain("# AGENTS.md");
      expect(markdown).toContain("## Project");
      expect(markdown).toContain("# Fake Project");
      expect(markdown).toContain("## Commands");
      expect(markdown).toContain("`pnpm test`");
      expect(markdown).toContain("`pnpm build`");
      expect(markdown).toContain("## Layout");
      expect(markdown).toContain("`src/`");
      expect(markdown).toContain("## Conventions");
      expect(markdown).toContain("TypeScript project");
      expect(markdown).toContain("pnpm as the package manager");
    });
  });

  describe("initProject", () => {
    it("writes AGENTS.md from the template when no model is available", async () => {
      makeFakeProject(cwd);
      const result = await initProject({ cwd, args: "", model: null });

      const target = path.join(cwd, "AGENTS.md");
      expect(result.written).toBe(true);
      expect(result.usedLlm).toBe(false);
      expect(result.path).toBe(target);
      expect(result.lines).toBeGreaterThan(5);
      expect(result.message).toContain(target);
      expect(result.message).toContain("No model available");
      expect(fs.readFileSync(target, "utf8")).toContain("# AGENTS.md");
    });

    it("refines the draft with the model when available", async () => {
      makeFakeProject(cwd);
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          text: "# AGENTS.md\n\nPolished by the model.\n",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 3 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      const result = await initProject({ cwd, args: "", model });

      expect(result.written).toBe(true);
      expect(result.usedLlm).toBe(true);
      expect(result.message).toContain("generated with model refinement");
      expect(fs.readFileSync(result.path, "utf8")).toBe("# AGENTS.md\n\nPolished by the model.\n");
    });

    it("falls back to the template when the model fails", async () => {
      makeFakeProject(cwd);
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          throw new Error("model unavailable");
        },
      });

      const result = await initProject({ cwd, args: "", model });

      expect(result.written).toBe(true);
      expect(result.usedLlm).toBe(false);
      expect(result.message).toContain("Model refinement failed");
      expect(fs.readFileSync(result.path, "utf8")).toContain("## Commands");
    });

    it("does not overwrite an existing AGENTS.md unless forced", async () => {
      makeFakeProject(cwd);
      const target = path.join(cwd, "AGENTS.md");
      fs.writeFileSync(target, "custom content\n");

      const skipped = await initProject({ cwd, args: "", model: null });
      expect(skipped.written).toBe(false);
      expect(skipped.message).toContain("already exists");
      expect(skipped.message).toContain("/init force");
      expect(fs.readFileSync(target, "utf8")).toBe("custom content\n");

      const forced = await initProject({ cwd, args: "force", model: null });
      expect(forced.written).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toContain("# AGENTS.md");
    });

    it("dispatches args to ctx.initProject", async () => {
      const registry = new CommandRegistry();
      registerBuiltinCommands(registry);
      const seen: string[] = [];
      const calls: string[] = [];
      const ctx = {
        addSystemMessage: (text: string) => calls.push(text),
        initProject: async (args: string) => {
          seen.push(args);
          return "init done";
        },
      } as unknown as CommandContext;

      await registry.get("init")?.run("force", ctx);

      expect(seen).toEqual(["force"]);
      expect(calls).toEqual(["init done"]);
    });
  });
});

describe("/doctor", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-doctor-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-doctor-cwd-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const reachable = async () => true;
  const unreachable = async () => false;

  it("reports all checks passing in a healthy setup", async () => {
    fs.writeFileSync(path.join(home, "config.toml"), 'defaultModel = "main"\n');
    const report = await runDoctor({
      cwd,
      config: makeConfig(),
      env: { TEST_PROVIDER_KEY: "sk-secret-value" },
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      shellPath: "D:\\Git\\bin\\bash.exe",
      fetcher: reachable,
    });

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.checks.length);
    const text = formatDoctorReport(report);
    expect(text).toContain("✓ Node.js version: v22.1.0");
    expect(text).toContain("✓ Shell for bash tool: bash");
    expect(text).toContain("✓ STAR_HOME / config:");
    expect(text).toContain("✓ Default model: main (openai/gpt-test, https://api.example.com/v1)");
    expect(text).toContain("✓ Provider API key:");
    expect(text).toContain("✓ Sessions directory writable:");
    expect(text).toContain("✓ npm registry connectivity:");
    expect(text).toContain(`${report.passed} passed, 0 failed`);
  });

  it("never leaks the API key value", async () => {
    const key = "sk-super-secret-key-12345";
    fs.writeFileSync(path.join(home, "config.toml"), 'defaultModel = "main"\n');
    const report = await runDoctor({
      cwd,
      config: makeConfig({
        providers: [
          {
            name: "openai",
            protocol: "openai-compatible",
            baseURL: "https://api.example.com/v1",
            apiKey: key,
          },
        ],
      }),
      env: {},
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      fetcher: reachable,
    });

    expect(report.checks.find((c: DoctorCheck) => c.name === "Provider API key")?.ok).toBe(true);
    const text = formatDoctorReport(report);
    expect(text).not.toContain(key);
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it("flags an outdated Node version and missing config", async () => {
    const report = await runDoctor({
      cwd,
      config: makeConfig(),
      env: { TEST_PROVIDER_KEY: "sk-secret-value" },
      nodeVersion: "v18.19.0",
      shellLabel: "cmd",
      fetcher: reachable,
    });

    const node = report.checks.find((c) => c.name === "Node.js version");
    expect(node?.ok).toBe(false);
    expect(node?.detail).toContain(">= 20");
    const config = report.checks.find((c) => c.name === "STAR_HOME / config");
    expect(config?.ok).toBe(false);
    expect(config?.detail).toContain("missing");
    expect(report.failed).toBe(2);
    expect(formatDoctorReport(report)).toContain(`${report.passed} passed, 2 failed`);
  });

  it("flags a missing default model and unresolved API key", async () => {
    fs.writeFileSync(path.join(home, "config.toml"), "");
    const report = await runDoctor({
      cwd,
      config: makeConfig({ defaultModel: "" }),
      env: {},
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      fetcher: reachable,
    });

    const model = report.checks.find((c) => c.name === "Default model");
    expect(model?.ok).toBe(false);
    expect(model?.detail).toContain("no defaultModel");
    expect(report.checks.some((c) => c.name === "Provider API key")).toBe(false);
  });

  it("flags an unresolved API key without printing it", async () => {
    fs.writeFileSync(path.join(home, "config.toml"), "");
    const report = await runDoctor({
      cwd,
      config: makeConfig(),
      env: {},
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      fetcher: reachable,
    });

    const key = report.checks.find((c) => c.name === "Provider API key");
    expect(key?.ok).toBe(false);
    expect(key?.detail).toContain("apiKey missing");
    expect(key?.detail).toContain("TEST_PROVIDER_KEY");
  });

  it("flags a non-writable sessions directory", async () => {
    const fileHome = path.join(cwd, "not-a-dir");
    fs.writeFileSync(fileHome, "I am a file");
    const report = await runDoctor({
      cwd,
      config: makeConfig(),
      env: { TEST_PROVIDER_KEY: "sk-secret-value" },
      home: fileHome,
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      fetcher: reachable,
    });

    const sessions = report.checks.find((c) => c.name === "Sessions directory writable");
    expect(sessions?.ok).toBe(false);
    expect(sessions?.detail).toContain("not writable");
  });

  it("marks registry connectivity as optional when unreachable", async () => {
    fs.writeFileSync(path.join(home, "config.toml"), "");
    const report = await runDoctor({
      cwd,
      config: makeConfig(),
      env: { TEST_PROVIDER_KEY: "sk-secret-value" },
      nodeVersion: "v22.1.0",
      shellLabel: "bash",
      fetcher: unreachable,
    });

    const registry = report.checks.find((c) => c.name === "npm registry connectivity");
    expect(registry?.ok).toBe(false);
    expect(registry?.optional).toBe(true);
    expect(registry?.detail).toContain("unreachable");
  });

  it("counts passes and failures in the summary line", async () => {
    const report = {
      checks: [
        { name: "a", ok: true, detail: "fine" },
        { name: "b", ok: false, detail: "broken" },
        { name: "c", ok: true, detail: "fine" },
      ],
      passed: 2,
      failed: 1,
    };
    const text = formatDoctorReport(report);
    expect(text).toBe("✓ a: fine\n✗ b: broken\n✓ c: fine\n\n2 passed, 1 failed");
  });

  it("dispatches to ctx.runDoctor", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const calls: string[] = [];
    const ctx = {
      addSystemMessage: (text: string) => calls.push(text),
      runDoctor: async () => "doctor done",
    } as unknown as CommandContext;

    await registry.get("doctor")?.run("", ctx);

    expect(calls).toEqual(["doctor done"]);
  });
});
