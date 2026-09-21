import { Text } from "ink";
import type { DiffLine } from "../diff-preview";

export function DiffLineView({ line }: { line: DiffLine }) {
  if (line.kind === "add") return <Text color="green">+ {line.text}</Text>;
  if (line.kind === "del") return <Text color="red">- {line.text}</Text>;
  if (line.kind === "marker") return <Text dimColor>{line.text}</Text>;
  return <Text dimColor> {line.text}</Text>;
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
