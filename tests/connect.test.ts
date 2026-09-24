import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectAnswers,
  apiKeyEnvFor,
  buildModelTomlBlock,
  buildProviderTomlBlock,
  dedupeName,
  deriveProviderName,
  maskApiKey,
  saveConnection,
  saveDefaultModel,
  setDefaultModelInToml,
} from "../src/cli/commands/connect";
import { loadEnvFile, parseEnvContent, upsertEnvContent } from "../src/config/env";
import { resolveApiKey } from "../src/config/keys";
import { loadConfigSync } from "../src/config/loader";
import { envFilePath, globalConfigPath } from "../src/config/paths";

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-cwd-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // delete (not = undefined): assigning undefined coerces to the string
  // "undefined", which the env loader would treat as a real value.
  // biome-ignore lint/performance/noDelete: see above
  delete process.env.STAR_API_KEY_OPENROUTER;
  // biome-ignore lint/performance/noDelete: see above
  delete process.env.STAR_TEST_EXISTING;
  // biome-ignore lint/performance/noDelete: see above
  delete process.env.STAR_TEST_NEW;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const answers: ConnectAnswers = {
  providerName: "openrouter",
  protocol: "openai-compatible",
  baseURL: "https://openrouter.ai/api/v1",
  apiKeyEnv: "STAR_API_KEY_OPENROUTER",
  apiKey: "sk-or-test-key-1234567890",
  modelName: "gpt-4o",
  modelId: "gpt-4o",
};

describe("deriveProviderName", () => {
  it("derives a slug from the baseURL host, skipping api/www labels", () => {
    expect(deriveProviderName("https://api.openai.com/v1")).toBe("openai");
    expect(deriveProviderName("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(deriveProviderName("https://api.moonshot.cn/v1")).toBe("moonshot");
    expect(deriveProviderName("https://www.example.com")).toBe("example");
    expect(deriveProviderName("https://api.deepseek.com/v1")).toBe("deepseek");
  });

  it("falls back to provider when nothing usable remains", () => {
    expect(deriveProviderName("https://api./")).toBe("provider");
  });
});

describe("dedupeName", () => {
  it("keeps the base name when free, otherwise appends a counter", () => {
    expect(dedupeName("openai", [])).toBe("openai");
    expect(dedupeName("openai", ["openai"])).toBe("openai-2");
    expect(dedupeName("openai", ["openai", "openai-2"])).toBe("openai-3");
  });
});

describe("apiKeyEnvFor", () => {
  it("builds an env var name from the provider name", () => {
    expect(apiKeyEnvFor("openrouter")).toBe("STAR_API_KEY_OPENROUTER");
    expect(apiKeyEnvFor("openrouter-2")).toBe("STAR_API_KEY_OPENROUTER_2");
  });
});

describe("maskApiKey", () => {
  it("shows only a short prefix and suffix of long keys", () => {
    const key = "sk-1234567890abcdef";
    const masked = maskApiKey(key);
    expect(masked).toBe("sk-…cdef");
    expect(masked).not.toContain(key);
  });

  it("fully masks short keys", () => {
    const masked = maskApiKey("short");
    expect(masked).toBe("••••••");
    expect(masked).not.toContain("short");
  });
});

describe("toml blocks", () => {
  it("renders a provider block with comments and no API key", () => {
    const block = buildProviderTomlBlock({
      name: "openrouter",
      protocol: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "STAR_API_KEY_OPENROUTER",
    });
    expect(block).toContain("[[providers]]");
    expect(block).toContain('name = "openrouter"');
    expect(block).toContain('protocol = "openai-compatible"');
    expect(block).toContain('apiKeyEnv = "STAR_API_KEY_OPENROUTER"');
    expect(block).toContain("# ~/.star-cli/.env");
    expect(block).not.toContain(answers.apiKey);
  });

  it("renders a model block with uncommented optional fields and comments", () => {
    const block = buildModelTomlBlock({
      name: "gpt-4o",
      provider: "openrouter",
      model: "gpt-4o",
      contextMaxTokens: 128000,
      promptPrice: 0,
      completionPrice: 0,
    });
    expect(block).toContain("[[models]]");
    expect(block).toContain("contextMaxTokens = 128000");
    expect(block).toContain("promptPrice = 0");
    expect(block).toContain("completionPrice = 0");
    expect(block).toContain("BOTH");
    expect(block).not.toContain(answers.apiKey);
  });
});

describe("env file helpers", () => {
  it("parses KEY=VALUE lines and skips comments and junk", () => {
    expect(parseEnvContent('# c\nFOO=bar\nEMPTY=\nquoted="a b"\nnot a line\n1BAD=x\n')).toEqual({
      FOO: "bar",
      EMPTY: "",
      quoted: "a b",
    });
  });

  it("upsert replaces an existing variable instead of appending a duplicate", () => {
    const content = "# keys\nFOO=old\nBAR=1\n";
    const next = upsertEnvContent(content, "FOO", "new");
    expect(next).toContain("FOO=new");
    expect(next).not.toContain("FOO=old");
    expect(next).toContain("BAR=1");
    expect(next).toContain("# keys");
    expect(next.match(/FOO=/g)).toHaveLength(1);
  });

  it("upsert appends a missing variable", () => {
    expect(upsertEnvContent("", "KEY", "v")).toBe("KEY=v\n");
    expect(upsertEnvContent("A=1\n", "KEY", "v")).toBe("A=1\nKEY=v\n");
  });

  it("loadEnvFile fills process.env without overwriting existing variables", () => {
    process.env.STAR_TEST_EXISTING = "real";
    fs.writeFileSync(envFilePath(), "STAR_TEST_EXISTING=fake\nSTAR_TEST_NEW=fresh\n");
    loadEnvFile();
    expect(process.env.STAR_TEST_EXISTING).toBe("real");
    expect(process.env.STAR_TEST_NEW).toBe("fresh");
  });

  it("loadEnvFile ignores a missing file", () => {
    expect(() => loadEnvFile(path.join(home, "does-not-exist"))).not.toThrow();
  });
});

describe("setDefaultModelInToml", () => {
  it("replaces the top-level defaultModel line and keeps the rest intact", () => {
    const content = 'defaultModel = "old"\n# keep me\n\n[[providers]]\nname = "x"\n';
    const next = setDefaultModelInToml(content, "new-model");
    expect(next).toContain('defaultModel = "new-model"');
    expect(next).not.toContain('defaultModel = "old"');
    expect(next).toContain("# keep me");
    expect(next).toContain('name = "x"');
  });

  it("inserts the line at the top when missing", () => {
    const next = setDefaultModelInToml("# hello\n", "m");
    expect(next.startsWith('defaultModel = "m"\n# hello\n')).toBe(true);
  });

  it("does not touch defaultModel keys inside sections", () => {
    const content = '[something]\ndefaultModel = "inner"\n';
    const next = setDefaultModelInToml(content, "top");
    expect(next.startsWith('defaultModel = "top"\n')).toBe(true);
    expect(next).toContain('defaultModel = "inner"');
  });

  it("saveDefaultModel writes the file", () => {
    saveDefaultModel("gpt-4o");
    expect(fs.readFileSync(globalConfigPath(), "utf8")).toContain('defaultModel = "gpt-4o"');
  });
});

describe("saveConnection", () => {
  it("appends provider/model blocks to config.toml and stores the key in .env", () => {
    fs.writeFileSync(
      globalConfigPath(),
      'defaultModel = "old"\n# my comment\n\n[[providers]]\nname = "openai"\nprotocol = "openai-compatible"\nbaseURL = "https://api.openai.com/v1"\napiKeyEnv = "OPENAI_API_KEY"\n',
    );
    const result = saveConnection(answers);
    expect(result.provider).toEqual({
      name: "openrouter",
      protocol: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "STAR_API_KEY_OPENROUTER",
    });
    expect(result.model).toEqual({
      name: "gpt-4o",
      provider: "openrouter",
      model: "gpt-4o",
      contextMaxTokens: 128000,
      promptPrice: 0,
      completionPrice: 0,
    });

    const content = fs.readFileSync(globalConfigPath(), "utf8");
    expect(content).toContain("# my comment");
    expect(content).toContain('defaultModel = "old"');
    expect(content).toContain('name = "openrouter"');
    expect(content).toContain("contextMaxTokens = 128000");
    expect(content).toContain("promptPrice = 0");
    expect(content).not.toContain(answers.apiKey);

    expect(fs.readFileSync(envFilePath(), "utf8")).toContain(
      `STAR_API_KEY_OPENROUTER=${answers.apiKey}`,
    );
    expect(process.env.STAR_API_KEY_OPENROUTER).toBe(answers.apiKey);
  });

  it("round-trips through the config loader, key resolved via .env", () => {
    saveConnection(answers);
    // biome-ignore lint/performance/noDelete: remove entirely so loadEnvFile must re-fill it
    delete process.env.STAR_API_KEY_OPENROUTER;
    const config = loadConfigSync(cwd);
    const provider = config.providers.find((p) => p.name === "openrouter");
    expect(provider?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(process.env.STAR_API_KEY_OPENROUTER).toBe(answers.apiKey);
    if (!provider) throw new Error("provider missing");
    expect(resolveApiKey(provider)).toBe(answers.apiKey);
    const model = config.models.find((m) => m.name === "gpt-4o");
    expect(model?.provider).toBe("openrouter");
    expect(model?.contextMaxTokens).toBe(128000);
    expect(model?.promptPrice).toBe(0);
    expect(model?.completionPrice).toBe(0);
  });

  it("updates an existing .env variable instead of duplicating it", () => {
    fs.writeFileSync(envFilePath(), "STAR_API_KEY_OPENROUTER=old-key\nOTHER=1\n");
    saveConnection(answers);
    const envContent = fs.readFileSync(envFilePath(), "utf8");
    expect(envContent).toContain(`STAR_API_KEY_OPENROUTER=${answers.apiKey}`);
    expect(envContent).not.toContain("old-key");
    expect(envContent).toContain("OTHER=1");
    expect(envContent.match(/STAR_API_KEY_OPENROUTER=/g)).toHaveLength(1);
  });
});
