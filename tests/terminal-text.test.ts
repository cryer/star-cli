import { describe, expect, it } from "vitest";
import { toTerminalSafe } from "../src/cli/terminal-text";

describe("toTerminalSafe", () => {
  it("returns clean text unchanged", () => {
    const text = "hello 世界 🙂\nsecond line";
    expect(toTerminalSafe(text)).toBe(text);
  });

  it("expands tabs to two spaces so Ink and the terminal agree on width", () => {
    expect(toTerminalSafe("\tindent")).toBe("  indent");
    expect(toTerminalSafe("a\tb")).toBe("a  b");
  });

  it("drops carriage returns and other C0 controls but keeps newlines", () => {
    expect(toTerminalSafe("a\r\nb")).toBe("a\nb");
    expect(toTerminalSafe("bell\u0007end")).toBe("bellend");
    expect(toTerminalSafe("line1\nline2")).toBe("line1\nline2");
  });

  it("strips raw ESC bytes so model output cannot inject terminal sequences", () => {
    expect(toTerminalSafe("\u001b[2J\u001b[1;1Hsafe")).toBe("[2J[1;1Hsafe");
    expect(toTerminalSafe("a\u001bb")).toBe("ab");
  });

  it("drops DEL and leaves CJK/emoji widths alone", () => {
    expect(toTerminalSafe("a\u007fb")).toBe("ab");
    expect(toTerminalSafe("中文🙂")).toBe("中文🙂");
  });
});
