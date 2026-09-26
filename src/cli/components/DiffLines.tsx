import { Text } from "ink";
import type { DiffLine } from "../diff-preview";
import { toTerminalSafe } from "../terminal-text";

export function DiffLineView({ line }: { line: DiffLine }) {
  // Diff content is model/tool-controlled text rendered outside the streaming
  // ingestion path, so it is normalized here at the render layer instead.
  const text = toTerminalSafe(line.text);
  if (line.kind === "add") return <Text color="green">+ {text}</Text>;
  if (line.kind === "del") return <Text color="red">- {text}</Text>;
  if (line.kind === "marker") return <Text dimColor>{text}</Text>;
  return <Text dimColor> {text}</Text>;
}

export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
        <DiffLineView key={index} line={line} />
      ))}
    </>
  );
}
