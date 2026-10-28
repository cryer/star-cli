import { useStdout } from "ink";
import { useEffect, useState } from "react";
import { terminalRows } from "./ink-stdout";

export const TERMINAL_RESIZE_DEBOUNCE_MS = 40;

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const readSize = (): TerminalSize => ({
    columns: stdout.columns || 80,
    rows: terminalRows(stdout) || 24,
  });
  const [size, setSize] = useState<TerminalSize>(readSize);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer = null;
      setSize({ columns: stdout.columns || 80, rows: terminalRows(stdout) || 24 });
    };
    const resized = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, TERMINAL_RESIZE_DEBOUNCE_MS);
    };
    stdout.on("resize", resized);
    refresh();
    return () => {
      stdout.off("resize", resized);
      if (timer) clearTimeout(timer);
    };
  }, [stdout]);
  return size;
}
