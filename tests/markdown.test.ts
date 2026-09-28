import { describe, expect, it } from "vitest";
import { cellWidth, renderInline, renderMarkdown } from "../src/cli/markdown";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
const ANSI_RE = /\u001B\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

describe("cellWidth", () => {
  it("counts CJK and emoji as double width", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("中文")).toBe(4);
    expect(cellWidth("a中b")).toBe(4);
    expect(cellWidth("💭")).toBe(2);
  });
});

describe("renderInline", () => {
  it("renders bold, italic, strikethrough and inline code", () => {
    const out = renderInline("a **b** *c* ~~d~~ `e`");
    expect(stripAnsi(out)).toBe("a b c d e");
    expect(out).toContain("\u001B[1m"); // bold
    expect(out).toContain("\u001B[3m"); // italic
    expect(out).toContain("\u001B[9m"); // strikethrough
    expect(out).toContain("\u001B[33m"); // yellow code
  });

  it("renders links as underlined label plus dim url", () => {
    const out = renderInline("see [the docs](https://example.com)");
    expect(stripAnsi(out)).toBe("see the docs (https://example.com)");
    expect(out).toContain("\u001B[4m");
  });

  it("renders images as a dim placeholder", () => {
    expect(stripAnsi(renderInline("![cat](cat.png)"))).toBe("[image: cat]");
  });

  it("leaves unclosed markers literal (streaming tail)", () => {
    expect(stripAnsi(renderInline("a **partial"))).toBe("a **partial");
    expect(stripAnsi(renderInline("a `partial"))).toBe("a `partial");
  });

  it("keeps snake_case identifiers literal", () => {
    expect(stripAnsi(renderInline("use foo_bar_baz here"))).toBe("use foo_bar_baz here");
  });

  it("does not parse markers inside code spans", () => {
    expect(stripAnsi(renderInline("`**not bold**`"))).toBe("**not bold**");
  });

  it("re-opens the base color after each styled span", () => {
    const out = renderInline("a **b** c", "32");
    expect(out).toContain("\u001B[0m\u001B[32m");
  });
});

describe("renderMarkdown", () => {
  it("renders headings in bold cyan without the #s", () => {
    const out = renderMarkdown("# Title");
    expect(stripAnsi(out)).toBe("Title");
    expect(out).toContain("\u001B[1;36m");
  });

  it("renders fenced code blocks with a gutter and no fence lines", () => {
    const out = renderMarkdown("before\n```js\nconst a = 1;\n```\nafter");
    const plain = stripAnsi(out);
    expect(plain).toContain("  ▎ js");
    expect(plain).toContain("  ▎const a = 1;");
    expect(plain).not.toContain("```");
    expect(plain).toContain("after");
  });

  it("treats an unclosed fence as code until the end (streaming)", () => {
    const plain = stripAnsi(renderMarkdown("```\ncode line"));
    expect(plain).toContain("  ▎code line");
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(stripAnsi(renderMarkdown("> quoted"))).toContain("  ▎quoted");
    expect(stripAnsi(renderMarkdown("---"))).toContain("────");
  });

  it("renders pipe tables as an aligned grid", () => {
    const md = "| Name | Age |\n| --- | ---: |\n| bob | 7 |\n| alice | 12 |";
    const plain = stripAnsi(renderMarkdown(md));
    const lines = plain.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("  Name  │ Age");
    expect(lines[1]).toBe("  ──────┼─────");
    expect(lines[2]).toBe("  bob   │ 7");
    expect(lines[3]).toBe(lines[1]);
    expect(lines[4]).toBe("  alice │ 12");
  });

  it("aligns CJK table cells by display width", () => {
    const md = "| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |\n| bb | 2 |";
    const lines = stripAnsi(renderMarkdown(md)).split("\n");
    // 名 is 2 cells wide, so "bb" needs no extra padding to align with it.
    expect(cellWidth(lines[2] ?? "")).toBe(cellWidth(lines[4] ?? ""));
  });

  it("wraps cells instead of truncating when the grid exceeds the terminal width", () => {
    const md = `| A |\n| --- |\n| ${"x".repeat(60)} |`;
    // Wide enough terminal: no wrapping.
    expect(stripAnsi(renderMarkdown(md)).split("\n")).toHaveLength(3);
    // Narrow terminal: the column shrinks and the cell wraps onto extra lines.
    const narrow = stripAnsi(renderMarkdown(md, "", 20));
    expect(narrow).not.toContain("…");
    const lines = narrow.split("\n");
    expect(lines).toHaveLength(6); // header + separator + 4 wrapped lines
    expect(lines.slice(2).join("").replaceAll(" ", "")).toContain("x".repeat(60));
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("grows the row height to the tallest wrapped cell", () => {
    const md = `| A | B |\n| --- | --- |\n| x | ${"y".repeat(30)} |`;
    const lines = stripAnsi(renderMarkdown(md, "", 26)).split("\n");
    // B wraps onto multiple lines; A's cell stays on the first of them.
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[2]).toContain("x");
    expect(lines[2]).toContain("│");
    expect(lines[3]).not.toContain("x");
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(26);
    }
  });

  it("leaves non-table pipe lines alone", () => {
    expect(stripAnsi(renderMarkdown("a | b without separator"))).toBe("a | b without separator");
  });
});
