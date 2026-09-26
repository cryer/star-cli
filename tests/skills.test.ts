import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import {
  SKILL_MAX_CHARS,
  createSkillTool,
  discoverSkills,
  formatSkillsBlock,
  loadSkillBody,
} from "../src/agent/skills";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

function writeSkill(base: string, name: string, content: string): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

const REVIEW_SKILL = `---
description: Review code for common issues
---
Check error handling, naming, and test coverage.
`;

describe("skills", () => {
  let cwd: string;
  let home: string;
  let projectSkills: string;
  let userSkills: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-skills-project-"));
    home = mkdtempSync(path.join(tmpdir(), "star-skills-home-"));
    projectSkills = path.join(cwd, ".star", "skills");
    userSkills = path.join(home, "skills");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers skills from user and project scopes", () => {
    writeSkill(userSkills, "review", REVIEW_SKILL);
    writeSkill(
      projectSkills,
      "deploy",
      "---\ndescription: Deploy the app\n---\nRun the deploy pipeline.\n",
    );
    const skills = discoverSkills(cwd, home);
    expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "review"]);
    expect(skills.find((s) => s.name === "review")?.scope).toBe("user");
    expect(skills.find((s) => s.name === "deploy")?.scope).toBe("project");
  });

  it("lets a project skill override a user skill of the same name", () => {
    writeSkill(userSkills, "review", REVIEW_SKILL);
    writeSkill(
      projectSkills,
      "review",
      "---\ndescription: Project-specific review\n---\nProject rules.\n",
    );
    const skills = discoverSkills(cwd, home);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("Project-specific review");
    expect(skills[0]?.scope).toBe("project");
  });

  it("defaults the skill name to the directory name and honors frontmatter name", () => {
    writeSkill(userSkills, "from-dir", REVIEW_SKILL);
    writeSkill(
      userSkills,
      "renamed",
      "---\nname: custom-name\ndescription: Renamed skill\n---\nBody.\n",
    );
    const names = discoverSkills(cwd, home).map((s) => s.name);
    expect(names.sort()).toEqual(["custom-name", "from-dir"]);
  });

  it("skips invalid directories, missing frontmatter, and missing descriptions", () => {
    writeSkill(userSkills, "Bad_Name", REVIEW_SKILL);
    writeSkill(userSkills, "no-frontmatter", "Just plain markdown.\n");
    writeSkill(userSkills, "no-description", "---\nname: no-description\n---\nBody.\n");
    mkdirSync(path.join(userSkills, "empty-dir"), { recursive: true });
    expect(discoverSkills(cwd, home)).toEqual([]);
  });

  it("returns an empty list when no skill directories exist", () => {
    expect(discoverSkills(cwd, home)).toEqual([]);
  });

  it("formats the system-prompt listing block", () => {
    writeSkill(userSkills, "review", REVIEW_SKILL);
    const block = formatSkillsBlock(discoverSkills(cwd, home));
    expect(block).toContain("# Available skills");
    expect(block).toContain("- review: Review code for common issues");
    expect(block).toContain("skill tool");
  });

  it("loads the skill body with frontmatter stripped and truncation applied", () => {
    const filePath = writeSkill(userSkills, "review", REVIEW_SKILL);
    const skill = discoverSkills(cwd, home)[0];
    expect(skill?.filePath).toBe(filePath);
    const body = skill ? loadSkillBody(skill) : null;
    expect(body).toBe("Check error handling, naming, and test coverage.");

    writeSkill(
      userSkills,
      "big",
      `---\ndescription: Big\n---\n${"x".repeat(SKILL_MAX_CHARS + 10)}`,
    );
    const big = discoverSkills(cwd, home).find((s) => s.name === "big");
    const bigBody = big ? loadSkillBody(big) : null;
    expect(bigBody).toContain(`[skill truncated to ${SKILL_MAX_CHARS} characters]`);
    expect(bigBody?.length).toBeLessThan(SKILL_MAX_CHARS + 100);
  });

  it("skill tool returns the body with its base directory", async () => {
    writeSkill(userSkills, "review", REVIEW_SKILL);
    const tool = createSkillTool({ cwd, home });
    expect(tool.name).toBe("skill");
    expect(tool.permission).toBe("read");
    const result = await tool.execute({ name: "review" }, { cwd });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("# Skill: review");
    expect(result.content).toContain("Check error handling, naming, and test coverage.");
    expect(result.content).toContain(path.join(userSkills, "review"));
  });

  it("skill tool reports unknown names with the available list", async () => {
    writeSkill(userSkills, "review", REVIEW_SKILL);
    const tool = createSkillTool({ cwd, home });
    const result = await tool.execute({ name: "nope" }, { cwd });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown skill: "nope"');
    expect(result.content).toContain("review");

    const emptyDir = mkdtempSync(path.join(tmpdir(), "star-skills-empty-"));
    const empty = createSkillTool({ cwd: emptyDir, home: emptyDir });
    const none = await empty.execute({ name: "nope" }, { cwd: emptyDir });
    expect(none.content).toContain("Available skills: none");
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("picks up skills created after the tool was constructed", async () => {
    const tool = createSkillTool({ cwd, home });
    writeSkill(userSkills, "late", "---\ndescription: Added later\n---\nLate body.\n");
    const result = await tool.execute({ name: "late" }, { cwd });
    expect(result.content).toContain("Late body.");
  });
});

describe("AgentLoop skills integration", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-skills-loop-"));
    home = mkdtempSync(path.join(tmpdir(), "star-skills-loop-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function makeConfig(): StarConfig {
    return {
      defaultModel: "test",
      permissionMode: "auto",
      providers: [],
      models: [],
      maxSteps: 50,
      contextMaxTokens: 100_000,
      contextCompaction: "summary",
      streamIdleTimeoutSec: 20,
      streamFirstChunkTimeoutSec: 300,
      streamMaxRetries: 3,
      maxAutoContinues: 2,
      notifyBell: true,
      notifyBellThresholdSec: 10,
      permissions: { allow: [], deny: [] },
      hooks: [],
      doomLoopThreshold: 3,
      gitSnapshots: true,
    };
  }

  async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  it("lists skills in the system prompt and registers the skill tool", async () => {
    writeSkill(path.join(cwd, ".star", "skills"), "review", REVIEW_SKILL);
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "done" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const registry = createDefaultRegistry();
    const loop = new AgentLoop({ model, registry, config: makeConfig(), cwd });
    expect(registry.get("skill")).toBeDefined();

    await collect(loop.stream("hello", new AbortController().signal));

    const prompt = capturedPrompt as { role: string; content: unknown }[];
    const system = prompt[0];
    expect(system?.role).toBe("system");
    expect(String(system?.content)).toContain("# Available skills");
    expect(String(system?.content)).toContain("- review: Review code for common issues");
  });

  it("omits the skills block when no skills exist", async () => {
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "done" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });
    await collect(loop.stream("hello", new AbortController().signal));
    const prompt = capturedPrompt as { role: string; content: unknown }[];
    expect(String(prompt[0]?.content ?? "")).not.toContain("# Available skills");
  });

  it("executes a skill tool call end to end", async () => {
    writeSkill(path.join(cwd, ".star", "skills"), "review", REVIEW_SKILL);
    type Chunk =
      | { type: "text-delta"; textDelta: string }
      | {
          type: "tool-call";
          toolCallType: "function";
          toolCallId: string;
          toolName: string;
          args: string;
        }
      | {
          type: "finish";
          finishReason: "stop" | "tool-calls";
          usage: { promptTokens: number; completionTokens: number };
        };
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call++;
        const chunks: Chunk[] =
          call === 1
            ? [
                {
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "call-1",
                  toolName: "skill",
                  args: JSON.stringify({ name: "review" }),
                },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { promptTokens: 5, completionTokens: 3 },
                },
              ]
            : [
                { type: "text-delta", textDelta: "reviewed" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { promptTokens: 5, completionTokens: 3 },
                },
              ];
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });
    const events = await collect(loop.stream("use the review skill", new AbortController().signal));
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type).toBe("tool-result");
    if (result?.type === "tool-result") {
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Check error handling, naming, and test coverage.");
    }
  });
});
