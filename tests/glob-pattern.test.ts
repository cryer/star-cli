import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "../src/tools/fs/util";

describe("globToRegExp", () => {
  it("matches * within a segment and ** across segments", () => {
    expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(matchesGlob("src/**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchesGlob("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("**", "a/b/c.txt")).toBe(true);
  });

  it("expands braces and one nested level", () => {
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/a/b.ts")).toBe(true);
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/a/b.tsx")).toBe(true);
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/a/b.js")).toBe(false);
    expect(matchesGlob("a.{ts,{js,mjs}}", "a.mjs")).toBe(true);
    expect(matchesGlob("a.{ts,{js,mjs}}", "a.js")).toBe(true);
    expect(matchesGlob("a.{ts,{js,mjs}}", "a.css")).toBe(false);
    expect(matchesGlob("{src,tests}/a.ts", "tests/a.ts")).toBe(true);
  });

  it("treats unterminated braces and commas outside braces literally", () => {
    expect(matchesGlob("a{ts", "a{ts")).toBe(true);
    expect(matchesGlob("a{ts", "ats")).toBe(false);
    expect(matchesGlob("a,b.txt", "a,b.txt")).toBe(true);
    expect(matchesGlob("a}.txt", "a}.txt")).toBe(true);
  });

  it("supports character classes, ranges and negation", () => {
    expect(matchesGlob("src/[ab].ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/[ab].ts", "src/c.ts")).toBe(false);
    expect(matchesGlob("src/[!ab].ts", "src/c.ts")).toBe(true);
    expect(matchesGlob("src/[!ab].ts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/[a-c].ts", "src/b.ts")).toBe(true);
    expect(matchesGlob("src/[]a].ts", "src/].ts")).toBe(true);
    expect(matchesGlob("src/[^a].ts", "src/^.ts")).toBe(true);
    expect(matchesGlob("src/[^a].ts", "src/b.ts")).toBe(false);
  });

  it("treats an unterminated class as a literal [", () => {
    expect(matchesGlob("src/[ab.ts", "src/[ab.ts")).toBe(true);
  });

  it("collapses consecutive **/ segments without changing semantics", () => {
    expect(globToRegExp("src/**/**/deep/*.ts").source).toBe(
      globToRegExp("src/**/deep/*.ts").source,
    );
    expect(matchesGlob("src/**/**/deep/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matchesGlob("src/**/**/deep/*.ts", "src/x/y/deep/a.ts")).toBe(true);
  });

  it("bare patterns match basenames, braces included", () => {
    expect(matchesGlob("*.{ts,tsx}", "src/deep/a.tsx")).toBe(true);
    expect(matchesGlob("*.ts", "a.ts")).toBe(true);
    expect(matchesGlob("*.ts", "a.js")).toBe(false);
  });

  it("escapes regex specials in literal segments", () => {
    expect(matchesGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchesGlob("a+b.txt", "aab.txt")).toBe(false);
    expect(matchesGlob("(v1)/x.txt", "(v1)/x.txt")).toBe(true);
  });
});
