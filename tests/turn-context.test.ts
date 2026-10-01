import { describe, expect, it } from "vitest";
import { attachTurnContext } from "../src/agent/loop";
import type { CoreMessage } from "../src/core/messages";

const CONTEXT = "Git context for the working directory (refreshed each turn):\nBranch: main";

describe("attachTurnContext", () => {
  it("returns the array unchanged without context or a user message", () => {
    const messages: CoreMessage[] = [{ role: "system", content: "S" }];
    expect(attachTurnContext(messages, null)).toBe(messages);
    expect(attachTurnContext(messages, "")).toBe(messages);
    expect(attachTurnContext(messages, CONTEXT)).toBe(messages);
  });

  it("prepends a system-reminder to a string user message", () => {
    const messages: CoreMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "do the thing" },
    ];
    const result = attachTurnContext(messages, CONTEXT);
    const content = result[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: `<system-reminder>\n${CONTEXT}\n</system-reminder>`,
    });
    expect(content[1]).toEqual({ type: "text", text: "do the thing" });
    // Originals are immutable history: no mutation, same array contents.
    expect(messages[1]?.content).toBe("do the thing");
  });

  it("targets the latest user message, not earlier ones", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];
    const result = attachTurnContext(messages, CONTEXT);
    expect(result[0]?.content).toBe("first");
    expect(Array.isArray(result[2]?.content)).toBe(true);
  });

  it("keeps existing array content (images) after the reminder", () => {
    const messages: CoreMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "AAAA", mimeType: "image/png" },
          { type: "text", text: "what is this" },
        ],
      },
    ];
    const result = attachTurnContext(messages, CONTEXT);
    const content = result[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("image");
  });
});
