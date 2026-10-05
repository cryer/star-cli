import { tool as aiTool, jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compactMessages,
  serializeSummaryInput,
  truncateSummaryInput,
} from "../src/context/compaction";
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolSchemaTokens,
} from "../src/context/tokens";
import type { CoreMessage, StarMessage } from "../src/core/messages";
import { createDefaultRegistry } from "../src/tools";

const system = (text: string): CoreMessage => ({ role: "system", content: text });
const user = (text: string): CoreMessage => ({ role: "user", content: text });
const assistant = (text: string): CoreMessage => ({ role: "assistant", content: text });
const toolCallAssistant = (id: string, args: unknown): CoreMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", args }],
});
const toolResult = (id: string, result: unknown): CoreMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", result }],
});

const star = (messages: CoreMessage[]): StarMessage[] => messages.map((message) => ({ message }));
const core = (messages: StarMessage[]): CoreMessage[] => messages.map((star) => star.message);

const pad = (n: number) => "x".repeat(n);

describe("estimateTokens", () => {
  it("is monotonic with message count and text length", () => {
    const short = user(pad(20));
    const long = user(pad(200));
    expect(estimateMessageTokens(long)).toBeGreaterThan(estimateMessageTokens(short));
    expect(estimateTokens([short, short])).toBeGreaterThan(estimateTokens([short]));
    expect(estimateTokens([])).toBe(0);
  });

  it("counts tool-call args and tool results", () => {
    const plain = estimateMessageTokens(assistant(""));
    const withCall = estimateMessageTokens(toolCallAssistant("c1", { path: pad(200) }));
    expect(withCall).toBeGreaterThan(plain);
    const withResult = estimateMessageTokens(toolResult("c1", pad(200)));
    expect(withResult).toBeGreaterThan(plain);
  });

  it("charges a flat estimate per image part", () => {
    const plain = estimateMessageTokens(user("hi"));
    const withImage = estimateMessageTokens({
      role: "user",
      content: [
        { type: "image", image: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "hi" },
      ],
    });
    expect(withImage).toBe(plain + 1024);
  });

  it("weights CJK characters near one token each", () => {
    const latin = estimateMessageTokens(user(pad(400)));
    const cjk = estimateMessageTokens(user("中".repeat(400)));
    // 400 CJK chars ≈ 400 tokens; the same length of Latin ≈ 100 tokens.
    expect(cjk).toBeGreaterThan(latin * 3);
  });

  it("counts CJK by code point even alongside surrogate pairs", () => {
    // "中" is one UTF-16 unit, "🙂" two: weight = 3 units + 1 CJK × 3 = 6,
    // ⌈6/4⌉ = 2 + 4 overhead = 6 — the astral char is never CJK-weighted.
    expect(estimateMessageTokens(user("中🙂"))).toBe(6);
  });
});

describe("compactMessages", () => {
  it("returns messages unchanged when under budget", () => {
    const messages = [system("sys"), user("hi"), assistant("hello")];
    const result = compactMessages(star(messages), 10_000);
    expect(result.compacted).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(core(result.messages)).toEqual(messages);
  });

  it("drops the earliest turn first when over budget", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const result = compactMessages(star(messages), 90);
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(2);
    expect(result.messages[0]?.message.role).toBe("system");
    expect(core(result.messages.slice(2))).toEqual(messages.slice(3));
  });

  it("always keeps the system message", () => {
    const messages = [system("sys"), ...Array.from({ length: 6 }, () => user(pad(400)))];
    const result = compactMessages(star(messages), 10);
    expect(result.messages[0]?.message).toEqual(system("sys"));
  });

  it("keeps the last 4 messages even when still over budget", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user(pad(400)),
      assistant(pad(400)),
      user("keep1"),
      assistant("keep2"),
      user("keep3"),
      assistant("keep4"),
    ];
    const result = compactMessages(star(messages), 1);
    expect(result.compacted).toBe(true);
    expect(core(result.messages.slice(-4))).toEqual(messages.slice(-4));
    expect(estimateTokens(core(result.messages))).toBeGreaterThan(1);
  });

  it("drops tool messages together with their assistant tool-call turn", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      toolCallAssistant("c1", { path: pad(400) }),
      toolResult("c1", pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const result = compactMessages(star(messages), 90);
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(3);
    expect(result.messages.some((m) => m.message.role === "tool")).toBe(false);
    for (const m of result.messages) {
      if (m.message.role === "tool") {
        throw new Error("orphan tool message");
      }
    }
    expect(core(result.messages.slice(2))).toEqual(messages.slice(4));
  });

  it("inserts a placeholder with the correct dropped count", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const result = compactMessages(star(messages), 90);
    const placeholder = result.messages[1];
    expect(placeholder?.message.role).toBe("user");
    expect(placeholder?.message.content).toBe("[context compacted: 2 earlier messages dropped]");
  });

  it("drops multiple turns incrementally until the budget is met", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user(pad(400)),
      assistant(pad(400)),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
    ];
    // Dropping only the first big turn still exceeds 100; both must go, and
    // the last 4 messages stay.
    const result = compactMessages(star(messages), 100);
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(4);
    expect(core(result.messages)).toEqual([
      system("sys"),
      { role: "user", content: "[context compacted: 4 earlier messages dropped]" },
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
    ]);
  });

  it("counts a synthetic user message as part of its turn, never a turn start", () => {
    const nudge: StarMessage = {
      message: user("[auto-continue] keep going"),
      meta: { synthetic: "nudge" },
    };
    const report: StarMessage = {
      message: user("[background subagent agent-1 completed]\nresult"),
      meta: { synthetic: "bg-report" },
    };
    const messages = [
      { message: system("sys") },
      { message: user(pad(400)) },
      { message: assistant(pad(400)) },
      nudge,
      report,
      { message: assistant("a1b") },
      { message: user("u2") },
      { message: assistant("a2") },
      { message: user("u3") },
      { message: assistant("a3") },
    ];
    const result = compactMessages(messages, 90);
    expect(result.compacted).toBe(true);
    // The first real turn spans five messages (user + assistant + nudge +
    // report + assistant): a boundary at the nudge would have dropped only
    // two and stranded the synthetic messages at the head.
    expect(result.droppedCount).toBe(5);
    expect(core(result.messages.slice(2))).toEqual([
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ]);
    expect(result.messages.some((m) => m.meta?.synthetic)).toBe(false);
  });

  it("force compacts even when under budget, keeping the last 4 messages", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const result = compactMessages(star(messages), 10_000, { force: true });
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(2);
    expect(result.messages[0]?.message.role).toBe("system");
    expect(result.messages[1]?.message.content).toBe(
      "[context compacted: 2 earlier messages dropped]",
    );
    expect(core(result.messages.slice(2))).toEqual(messages.slice(3));
  });

  it("force still refuses when no whole turn can be dropped", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")];
    const result = compactMessages(star(messages), 10_000, { force: true });
    expect(result.compacted).toBe(false);
    expect(core(result.messages)).toEqual(messages);
  });

  it("counts overheadTokens against the budget", () => {
    const messages = [
      system("sys"),
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    // ~210 estimated tokens: under a 500 budget without overhead…
    const plain = compactMessages(star(messages), 500);
    expect(plain.compacted).toBe(false);
    // …but over it once a tool-schema-sized overhead is charged.
    const withOverhead = compactMessages(star(messages), 500, { overheadTokens: 1000 });
    expect(withOverhead.compacted).toBe(true);
    expect(withOverhead.droppedCount).toBeGreaterThan(0);
  });

  it("keeps the last 4 messages when overhead alone exceeds the budget", () => {
    const messages = [
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const result = compactMessages(star(messages), 90, { overheadTokens: 5000 });
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(2);
    expect(core(result.messages.slice(-4))).toEqual(messages.slice(-4));
  });
});

describe("truncateSummaryInput", () => {
  it("passes short transcripts through unchanged", () => {
    const text = "user: hello\nassistant: hi";
    expect(truncateSummaryInput(text)).toBe(text);
  });

  it("caps long transcripts, keeping head and tail with an omission marker", () => {
    const head = `H${"h".repeat(23_999)}`;
    const middle = "m".repeat(100_000);
    const tail = `T${"t".repeat(10_000)}`;
    const result = truncateSummaryInput(head + middle + tail);
    expect(result.length).toBeLessThan(81_000);
    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).toContain("54001 characters omitted");
    // Only part of the middle survives inside the kept tail window.
    expect((result.match(/m/g) ?? []).length).toBeLessThan(50_000);
  });
});

describe("serializeSummaryInput", () => {
  // String-content messages serialize trivially as `${role}: ${content}`, so
  // the reference pipeline (join everything, then truncate) can be rebuilt
  // exactly and the budgeted serializer compared byte-for-byte.
  const reference = (messages: CoreMessage[]): string =>
    truncateSummaryInput(messages.map((m) => `${m.role}: ${m.content as string}`).join("\n"));

  it("matches the join-then-truncate reference on short input", () => {
    const messages = [user("hello"), assistant("hi there"), user("next")];
    expect(serializeSummaryInput(messages)).toBe(reference(messages));
  });

  it("matches the reference on a long transcript, omission count included", () => {
    const messages = [user(pad(24_000)), assistant(pad(100_000)), user(pad(10_000))];
    const result = serializeSummaryInput(messages);
    expect(result).toBe(reference(messages));
    expect(result).toContain("characters omitted");
  });

  it("matches the reference when a separator lands exactly on the head budget", () => {
    // "user: " + content = 23_999 chars, so the head budget ends on the "\n".
    const messages = [user(pad(23_993)), assistant(pad(100_000)), user(pad(10_000))];
    expect(serializeSummaryInput(messages)).toBe(reference(messages));
  });

  it("matches the reference across a deterministic sweep of message sizes", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 30; round++) {
      const messages = Array.from({ length: 3 + rand(8) }, (_, i) =>
        i % 2 === 0 ? user(pad(rand(40_000))) : assistant(pad(rand(40_000))),
      );
      expect(serializeSummaryInput(messages)).toBe(reference(messages));
    }
  });
});

describe("estimateToolSchemaTokens", () => {
  it("returns 0 for an empty tool map", () => {
    expect(estimateToolSchemaTokens({})).toBe(0);
  });

  it("estimates zod-backed tools from their wire JSON schema", () => {
    const tools = {
      read_file: aiTool({
        description: "Reads a file from disk",
        parameters: z.object({ path: z.string().describe("the file path") }),
      }),
    };
    const tokens = estimateToolSchemaTokens(tools);
    expect(tokens).toBeGreaterThan(0);
    // The zod shape must actually be counted: adding fields grows the estimate.
    const bigger = {
      read_file: aiTool({
        description: "Reads a file from disk",
        parameters: z.object({
          path: z.string().describe("the file path"),
          offset: z.number().describe("line offset"),
          limit: z.number().describe("max lines"),
        }),
      }),
    };
    expect(estimateToolSchemaTokens(bigger)).toBeGreaterThan(tokens);
  });

  it("estimates the default registry's tool map at a meaningful size", () => {
    // Guards the premise of the compaction charge: a real tool set is
    // thousands of tokens, not a rounding error.
    const tools: Record<string, unknown> = {};
    for (const t of createDefaultRegistry().list()) {
      tools[t.name] = aiTool({ description: t.description, parameters: t.parameters as never });
    }
    expect(Object.keys(tools).length).toBeGreaterThan(10);
    expect(estimateToolSchemaTokens(tools)).toBeGreaterThan(1000);
  });

  it("handles SDK jsonSchema wrappers and unserializable tools without throwing", () => {
    const wrapped = aiTool({
      description: "wrapped",
      parameters: jsonSchema({ type: "object", properties: { a: { type: "string" } } }),
    });
    expect(estimateToolSchemaTokens({ wrapped })).toBeGreaterThan(0);
    const weird = { description: "no schema", parameters: { not: "a zod schema" } };
    expect(estimateToolSchemaTokens({ weird })).toBeGreaterThanOrEqual(0);
  });
});
