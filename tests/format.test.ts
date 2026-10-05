import { describe, expect, it } from "vitest";
import { buildDisplayMessages, formatElapsedSeconds, formatStreamError } from "../src/cli/format";
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

  it("folds tool calls in place as dim one-line summaries", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "读一下文件" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "read_file", args: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", result: "ok" }],
      },
      { role: "assistant", content: "文件内容如上" },
    ];
    const display = buildDisplayMessages(messages);
    expect(display.map((m) => m.role)).toEqual(["user", "tool", "assistant", "system"]);
    expect(display[1]?.text).toContain("read_file {}");
    expect(display[1]?.dim).toBe(true);
    // Only the tool-result message stays collapsed; the call itself is shown.
    expect(display[3]?.text).toBe("Restored 1 history message(s) not shown here.");
  });

  it("keeps tool-call fold lines in their original order across a turn", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "读完 a 再改 b" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "先读 a" },
          { type: "tool-call", toolCallId: "1", toolName: "read_file", args: { path: "a.ts" } },
          { type: "tool-call", toolCallId: "2", toolName: "edit_file", args: { path: "b.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", result: "ok" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "2", toolName: "edit_file", result: "ok" }],
      },
      { role: "assistant", content: "改完了" },
    ];
    const display = buildDisplayMessages(messages);
    expect(display.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "system",
    ]);
    expect(display[1]?.text).toBe("先读 a");
    expect(display[2]?.text).toContain('read_file {"path":"a.ts"}');
    expect(display[3]?.text).toContain('edit_file {"path":"b.ts"}');
    expect(display[2]?.dim).toBe(true);
    expect(display[3]?.dim).toBe(true);
    expect(display[4]?.text).toBe("改完了");
    expect(display[5]?.text).toBe("Restored 2 history message(s) not shown here.");
  });

  it("truncates long tool arguments to a single bounded line", () => {
    const messages: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "write_file",
            args: { path: "a.ts", content: "x".repeat(500) },
          },
        ],
      },
    ];
    const display = buildDisplayMessages(messages);
    expect(display).toHaveLength(1);
    expect(display[0]?.text).not.toContain("\n");
    expect(display[0]?.text.length).toBeLessThan(140);
    expect(display[0]?.text).toContain("...");
  });

  it("still collapses text-less messages without tool calls into the count note", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: [{ type: "image", image: new Uint8Array([1]) }] },
      { role: "assistant", content: "收到图片" },
    ];
    const display = buildDisplayMessages(messages);
    expect(display.map((m) => m.role)).toEqual(["assistant", "system"]);
    expect(display[1]?.text).toBe("Restored 1 history message(s) not shown here.");
  });

  it("escapes terminal control characters in restored history text", () => {
    const messages: CoreMessage[] = [{ role: "user", content: "tab\there\r\nnext" }];
    const display = buildDisplayMessages(messages);
    expect(display[0]?.text).toBe("tab  here\nnext");
  });

  it("returns an empty list for empty input", () => {
    expect(buildDisplayMessages([])).toEqual([]);
  });
});

describe("formatStreamError", () => {
  it("appends a truncation hint to truncated JSON stream errors", () => {
    const error = new SyntaxError("Unexpected end of JSON input");
    expect(formatStreamError(error)).toBe(
      "Unexpected end of JSON input (response stream was truncated — try again)",
    );
  });

  it("leaves other error messages unchanged", () => {
    expect(formatStreamError(new Error("socket hang up"))).toBe("socket hang up");
  });
});

describe("formatElapsedSeconds", () => {
  it("shows plain seconds under a minute", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(3)).toBe("3s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  it("shows minutes and seconds past a minute", () => {
    expect(formatElapsedSeconds(60)).toBe("1m0s");
    expect(formatElapsedSeconds(125)).toBe("2m5s");
    expect(formatElapsedSeconds(3599)).toBe("59m59s");
  });

  it("shows hours, minutes and seconds past an hour", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h0m0s");
    expect(formatElapsedSeconds(3725)).toBe("1h2m5s");
  });
});
