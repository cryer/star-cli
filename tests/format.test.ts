import { describe, expect, it } from "vitest";
import { buildDisplayMessages } from "../src/cli/format";
import type { CoreMessage } from "../src/core/messages";

describe("buildDisplayMessages", () => {
  it("keeps user and assistant text messages", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
    ];
    const display = buildDisplayMessages(messages);
    expect(display).toEqual([
      { id: 0, role: "user", text: "你好" },
      { id: 1, role: "assistant", text: "你好，有什么可以帮你？" },
    ]);
  });

  it("collapses tool and text-less messages into a count note", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "读一下文件" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "read", args: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "read", result: "ok" }],
      },
      { role: "assistant", content: "文件内容如上" },
    ];
    const display = buildDisplayMessages(messages);
    expect(display.map((m) => m.role)).toEqual(["user", "assistant", "system"]);
    expect(display[2]?.text).toBe("已恢复 2 条历史消息");
  });

  it("returns an empty list for empty input", () => {
    expect(buildDisplayMessages([])).toEqual([]);
  });
});
