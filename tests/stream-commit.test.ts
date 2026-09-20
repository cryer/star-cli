import { describe, expect, it } from "vitest";
import { splitCommittableLines } from "../src/cli/format";

describe("splitCommittableLines", () => {
  it("returns null when there is no newline", () => {
    expect(splitCommittableLines("still growing", 1)).toBeNull();
  });

  it("returns null until enough complete lines accumulated", () => {
    const text = "one\ntwo\nthree";
    expect(splitCommittableLines(text, 8)).toBeNull();
    expect(splitCommittableLines(text, 3)).toBeNull();
  });

  it("commits complete lines once the threshold is reached, keeping the partial tail", () => {
    const text = "l1\nl2\nl3\npartial";
    expect(splitCommittableLines(text, 3)).toEqual({
      committed: "l1\nl2\nl3",
      rest: "partial",
    });
  });

  it("handles a trailing newline by leaving an empty tail", () => {
    expect(splitCommittableLines("a\nb\n", 2)).toEqual({ committed: "a\nb", rest: "" });
  });

  it("commits far along buffers in one shot", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const result = splitCommittableLines(`${lines.join("\n")}\ntail`, 8);
    expect(result).toEqual({ committed: lines.join("\n"), rest: "tail" });
  });
});
