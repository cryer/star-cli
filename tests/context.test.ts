import { describe, expect, it } from "vitest";
import { compactMessages } from "../src/context/compaction";
import { estimateMessageTokens, estimateTokens } from "../src/context/tokens";
import type { CoreMessage } from "../src/core/messages";

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
});

describe("compactMessages", () => {
  it("returns messages unchanged when under budget", () => {
    const messages = [system("sys"), user("hi"), assistant("hello")];
    const result = compactMessages(messages, 10_000);
    expect(result.compacted).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(messages);
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
    const result = compactMessages(messages, 90);
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(2);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages.slice(2)).toEqual(messages.slice(3));
  });

  it("always keeps the system message", () => {
    const messages = [system("sys"), ...Array.from({ length: 6 }, () => user(pad(400)))];
    const result = compactMessages(messages, 10);
    expect(result.messages[0]).toEqual(system("sys"));
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
    const result = compactMessages(messages, 1);
    expect(result.compacted).toBe(true);
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(estimateTokens(result.messages)).toBeGreaterThan(1);
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
    const result = compactMessages(messages, 90);
    expect(result.compacted).toBe(true);
    expect(result.droppedCount).toBe(3);
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
    for (const m of result.messages) {
      if (m.role === "tool") {
        throw new Error("orphan tool message");
      }
    }
    expect(result.messages.slice(2)).toEqual(messages.slice(4));
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
    const result = compactMessages(messages, 90);
    const placeholder = result.messages[1];
    expect(placeholder?.role).toBe("user");
    expect(placeholder?.content).toBe("[context compacted: 2 earlier messages dropped]");
  });
});
