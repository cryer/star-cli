import { describe, expect, it } from "vitest";
import { PLAIN_TOOL_ICONS, resolveIconMode } from "../src/cli/icons";

describe("resolveIconMode", () => {
  it("honors the STAR_ICONS override", () => {
    expect(resolveIconMode({ STAR_ICONS: "emoji", WT_SESSION: "x" })).toBe("emoji");
    expect(resolveIconMode({ STAR_ICONS: "plain", WT_SESSION: "x" })).toBe("plain");
  });

  it("enables emoji on terminals with known double-width emoji", () => {
    expect(resolveIconMode({ WT_SESSION: "abc" })).toBe("emoji");
    expect(resolveIconMode({ TERM_PROGRAM: "vscode" })).toBe("emoji");
    expect(resolveIconMode({ TERM_PROGRAM: "WezTerm" })).toBe("emoji");
    expect(resolveIconMode({ TERM: "xterm-kitty" })).toBe("emoji");
  });

  it("falls back to plain on mintty, conhost and unknown terminals", () => {
    expect(resolveIconMode({ TERM_PROGRAM: "mintty", TERM: "xterm" })).toBe("plain");
    expect(resolveIconMode({})).toBe("plain");
  });
});

describe("plain icon set", () => {
  it("uses only single-width non-emoji glyphs", () => {
    // string-width counts Emoji-property characters as width 2 even in text
    // presentation (✔, ☰, …), while terminals without emoji fonts render them
    // narrow — that mismatch is what broke Ink's frame erase. Plain icons
    // must stay single-codepoint, below the emoji block, and carry no VS16.
    for (const [name, icon] of Object.entries({ ...PLAIN_TOOL_ICONS, fallback: "▸" })) {
      const points = [...icon].map((c) => c.codePointAt(0) ?? 0);
      expect(points.length, `${name}: ${icon}`).toBe(1);
      expect(points[0], `${name}: ${icon}`).toBeLessThan(0x1f000);
    }
  });
});
