import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiKey } from "../src/config/keys";
import { loadConfig, loadConfigSync } from "../src/config/loader";
import { globalConfigPath, projectConfigPath, sessionsDir, starHome } from "../src/config/paths";
import type { ProviderConfig } from "../src/config/schema";

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

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("paths", () => {
  it("uses STAR_HOME when set", () => {
    expect(starHome()).toBe(home);
    expect(globalConfigPath()).toBe(path.join(home, "config.toml"));
    expect(sessionsDir()).toBe(path.join(home, "sessions"));
  });

  it("falls back to ~/.star-cli without STAR_HOME", () => {
    vi.unstubAllEnvs();
    expect(starHome()).toBe(path.join(os.homedir(), ".star-cli"));
  });

  it("computes the project config path from cwd", () => {
    expect(projectConfigPath(cwd)).toBe(path.join(cwd, ".star", "config.toml"));
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config files exist", async () => {
    const config = await loadConfig(cwd);
    expect(config).toEqual({
      defaultModel: "",
      permissionMode: "ask",
      providers: [],
      models: [],
      maxSteps: 50,
      contextMaxTokens: 100_000,
      streamIdleTimeoutSec: 20,
      contextCompaction: "summary",
      permissions: { allow: [] },
      hooks: [],
    });
  });

  it("loads the global config file", async () => {
    writeFile(
      globalConfigPath(),
      `defaultModel = "fast"
maxSteps = 10
permissionMode = "auto"
`,
    );
    const config = await loadConfig(cwd);
    expect(config.defaultModel).toBe("fast");
    expect(config.maxSteps).toBe(10);
    expect(config.permissionMode).toBe("auto");
    expect(config.contextMaxTokens).toBe(100_000);
  });

  it("project config overrides global config", async () => {
    writeFile(
      globalConfigPath(),
      `defaultModel = "global-model"
maxSteps = 10
`,
    );
    writeFile(projectConfigPath(cwd), `defaultModel = "project-model"`);
    const config = await loadConfig(cwd);
    expect(config.defaultModel).toBe("project-model");
    expect(config.maxSteps).toBe(10);
  });

  it("CLI overrides take highest priority", async () => {
    writeFile(globalConfigPath(), `defaultModel = "global-model"`);
    writeFile(projectConfigPath(cwd), `defaultModel = "project-model"`);
    const config = await loadConfig(cwd, {
      model: "cli-model",
      permissionMode: "readonly",
    });
    expect(config.defaultModel).toBe("cli-model");
    expect(config.permissionMode).toBe("readonly");
  });

  it("parses contextCompaction from TOML", async () => {
    writeFile(globalConfigPath(), `contextCompaction = "truncate"`);
    const config = await loadConfig(cwd);
    expect(config.contextCompaction).toBe("truncate");
  });

  it("loadConfigSync matches loadConfig", async () => {
    writeFile(globalConfigPath(), "maxSteps = 7");
    const asyncConfig = await loadConfig(cwd, { model: "m" });
    const syncConfig = loadConfigSync(cwd, { model: "m" });
    expect(syncConfig).toEqual(asyncConfig);
  });

  it("throws a path-tagged error on bad TOML", async () => {
    writeFile(globalConfigPath(), "defaultModel = [broken");
    await expect(loadConfig(cwd)).rejects.toThrow(globalConfigPath());
  });

  it("throws a path-tagged error on schema violation", async () => {
    writeFile(projectConfigPath(cwd), `maxSteps = "not-a-number"`);
    await expect(loadConfig(cwd)).rejects.toThrow(projectConfigPath(cwd));
  });

  it("parses providers and models from TOML", async () => {
    writeFile(
      globalConfigPath(),
      `defaultModel = "main"

[[providers]]
name = "openai"
baseURL = "https://api.openai.com/v1"
apiKeyEnv = "TEST_STAR_API_KEY"

[[models]]
name = "main"
provider = "openai"
model = "gpt-4o"
`,
    );
    const config = await loadConfig(cwd);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.protocol).toBe("openai-compatible");
    expect(config.models[0]?.model).toBe("gpt-4o");
  });

  it("parses the openai-responses protocol from TOML", async () => {
    writeFile(
      globalConfigPath(),
      `[[providers]]
name = "relay"
protocol = "openai-responses"
baseURL = "https://relay.example.com/v1"
apiKeyEnv = "TEST_STAR_API_KEY"
`,
    );
    const config = await loadConfig(cwd);
    expect(config.providers[0]?.protocol).toBe("openai-responses");
  });
});

describe("resolveApiKey", () => {
  const provider: ProviderConfig = {
    name: "openai",
    protocol: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "TEST_STAR_API_KEY",
  };

  it("prefers the environment variable", () => {
    vi.stubEnv("TEST_STAR_API_KEY", "env-key");
    expect(resolveApiKey({ ...provider, apiKey: "file-key" })).toBe("env-key");
  });

  it("falls back to the configured apiKey", () => {
    expect(resolveApiKey({ ...provider, apiKey: "file-key" })).toBe("file-key");
  });

  it("uses apiKey when apiKeyEnv is unset", () => {
    const { apiKeyEnv, ...rest } = provider;
    expect(resolveApiKey({ ...rest, apiKey: "file-key" })).toBe("file-key");
  });

  it("throws a descriptive error when no key is available", () => {
    expect(() => resolveApiKey(provider)).toThrow(/TEST_STAR_API_KEY/);
    expect(() => resolveApiKey(provider)).toThrow(/openai/);
  });
});
