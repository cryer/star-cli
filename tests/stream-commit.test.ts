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

  it("never splits inside a pipe table", () => {
    const table = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "| 5 | 6 |",
      "| 7 | 8 |",
      "| 9 | 10 |",
      "| 11 | 12 |",
      "| 13 | 14 |",
    ];
    // Mid-table: nothing is safe to commit, the table must stay whole.
    expect(splitCommittableLines(`${table.join("\n")}\n| 15`, 8)).toBeNull();
    // Once a non-pipe line ends the table, everything commits together.
    expect(splitCommittableLines(`${table.join("\n")}\ndone\ntail`, 8)).toEqual({
      committed: `${table.join("\n")}\ndone`,
      rest: "tail",
    });
  });

  it("keeps prose before a table committable without touching the table", () => {
    const text = "intro line\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(splitCommittableLines(text, 1)).toEqual({
      committed: "intro line",
      rest: "| a | b |\n|---|---|\n| 1 | 2 |\n",
    });
  });

  it("never splits inside a fenced code block", () => {
    const fence = ["```ts", "const a = 1;", "const b = 2;", "const c = 3;"];
    expect(splitCommittableLines(`${fence.join("\n")}\nconst d`, 2)).toBeNull();
    expect(splitCommittableLines(`${fence.join("\n")}\n\`\`\`\ntail`, 2)).toEqual({
      committed: `${fence.join("\n")}\n\`\`\``,
      rest: "tail",
    });
  });
});
