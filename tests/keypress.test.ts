import { describe, expect, it } from "vitest";
import { splitKeypresses, toInputKey } from "../src/cli/keypress";

describe("splitKeypresses", () => {
  it("splits coalesced arrow keys into separate units", () => {
    expect(splitKeypresses("\u001B[A\u001B[A")).toEqual(["\u001B[A", "\u001B[A"]);
    expect(splitKeypresses("\u001B[A\u001B[B\u001B[C\u001B[D")).toEqual([
      "\u001B[A",
      "\u001B[B",
      "\u001B[C",
      "\u001B[D",
    ]);
  });

  it("keeps plain text runs intact so pastes stay one input event", () => {
    expect(splitKeypresses("hello world")).toEqual(["hello world"]);
    expect(splitKeypresses("line1\r\nline2")).toEqual(["line1\r\nline2"]);
  });

  it("splits text mixed with escape sequences", () => {
    expect(splitKeypresses("a\u001B[A b")).toEqual(["a", "\u001B[A", " b"]);
  });

  it("splits two bare escapes for double-Esc detection", () => {
    expect(splitKeypresses("\u001B\u001B")).toEqual(["\u001B", "\u001B"]);
  });

  it("keeps meta sequences and bracketed-paste markers as single units", () => {
    expect(splitKeypresses("\u001Bv")).toEqual(["\u001Bv"]);
    expect(splitKeypresses("\u001B\u001B[A")).toEqual(["\u001B\u001B[A"]);
    expect(splitKeypresses("\u001B[200~pasted\u001B[201~")).toEqual([
      "\u001B[200~",
      "pasted",
      "\u001B[201~",
    ]);
  });

  it("returns a trailing incomplete sequence as-is", () => {
    expect(splitKeypresses("abc\u001B")).toEqual(["abc", "\u001B"]);
  });
});

describe("toInputKey", () => {
  it("maps arrow sequences to key flags with empty input", () => {
    const { input, key } = toInputKey("\u001B[A");
    expect(input).toBe("");
    expect(key.upArrow).toBe(true);
    expect(key.ctrl).toBe(false);
  });

  it("maps printable text runs to input", () => {
    const { input, key } = toInputKey("hello");
    expect(input).toBe("hello");
    expect(key.return).toBe(false);
  });

  it("maps carriage return to the return key", () => {
    const { key } = toInputKey("\r");
    expect(key.return).toBe(true);
  });

  it("maps ctrl+letter to input letter with ctrl flag", () => {
    const { input, key } = toInputKey("\x12");
    expect(input).toBe("r");
    expect(key.ctrl).toBe(true);
  });

  it("maps shift+tab to tab with shift", () => {
    const { key } = toInputKey("\u001B[Z");
    expect(key.tab).toBe(true);
    expect(key.shift).toBe(true);
  });

  it("maps bracketed-paste markers to paste-marker input", () => {
    const { input } = toInputKey("\u001B[200~");
    expect(input).toBe("[200~");
  });

  it("maps meta+v to input v with meta flag", () => {
    const { input, key } = toInputKey("\u001Bv");
    expect(input).toBe("v");
    expect(key.meta).toBe(true);
  });

  it("maps alt+enter (ESC CR) to input CR like Ink did", () => {
    const { input, key } = toInputKey("\u001B\r");
    expect(input).toBe("\r");
    expect(key.return).toBe(false);
  });
});
