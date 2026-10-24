import { Box, Text, useStdout } from "ink";
import { memo } from "react";
import { formatDollars, formatTokens, formatTokensCompact } from "../cost";
import { folderIcon } from "../icons";
import { displayWidth, toTerminalSafe, truncateToWidth } from "../terminal-text";

interface StatusBarProps {
  cwd: string;
  model: string;
  permissionMode: string;
  tokens: number;
  // Git branch, refreshed on turn boundaries by the parent (null = not a repo).
  gitBranch?: string | null;
  // Context window usage in percent; null when unknown (non-loop backend).
  contextPercent?: number | null;
  // Token counts behind contextPercent, rendered as "(used/window)".
  contextTokens?: { used: number; window: number } | null;
  // Prompt cache hit rate 0-100; null when the provider never reported cache
  // fields (rendered as "Not provided").
  cachePercent?: number | null;
  sessionCostUsd?: number | null;
  // Labels of currently running background tasks (description or command).
  backgroundTasks?: string[];
}

const BG_LABEL_MAX = 40;
const BG_PER_LABEL_MAX = 24;
const WIDE_COLUMNS = 120;

function cwdLabel(cwd: string, wide: boolean): string {
  if (wide) return cwd;
  const base = cwd
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return base && base.length > 0 ? base : cwd;
}

export function fitStatusSegments(segments: Array<string | null>, columns: number): string[] {
  const clean = segments
    .filter((s): s is string => s != null)
    .map((s) => toTerminalSafe(s).replaceAll("\n", " "));
  if (clean.length === 0) return [];
  const available = Math.max(0, columns - clean.length + 1);
  const widths = clean.map(displayWidth);
  const budgets = clean.map(() => 0);
  let active = clean.map((_, index) => index);
  let remaining = available;
  while (remaining > 0 && active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share === 0) {
      for (const index of active.slice(0, remaining)) budgets[index] = (budgets[index] ?? 0) + 1;
      break;
    }
    let used = 0;
    const next: number[] = [];
    for (const index of active) {
      const grant = Math.min((widths[index] ?? 0) - (budgets[index] ?? 0), share);
      budgets[index] = (budgets[index] ?? 0) + grant;
      used += grant;
      if ((budgets[index] ?? 0) < (widths[index] ?? 0)) next.push(index);
    }
    if (used === 0) break;
    remaining -= used;
    active = next;
  }
  return clean.map((segment, index) => truncateToWidth(segment, budgets[index] ?? 0));
}

export const StatusBar = memo(function StatusBar({
  cwd,
  model,
  permissionMode,
  tokens,
  gitBranch,
  contextPercent,
  contextTokens,
  cachePercent,
  sessionCostUsd,
  backgroundTasks = [],
}: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const wide = columns >= WIDE_COLUMNS;
  const cwdSegment = `${folderIcon}${cwdLabel(cwd, wide)}${gitBranch ? ` [${gitBranch}]` : ""}`;
  const modelSegment = `✦ ${model}`;
  const ctxSegment =
    contextPercent != null
      ? `ctx: ${contextPercent}%${
          contextTokens
            ? ` (${formatTokensCompact(contextTokens.used)}/${formatTokensCompact(contextTokens.window)})`
            : ""
        }`
      : null;
  const cacheSegment = `cache: ${cachePercent != null ? `${cachePercent}%` : "Not provided"}`;
  const costSegment =
    sessionCostUsd != null && sessionCostUsd > 0 ? `$${formatDollars(sessionCostUsd)}` : null;
  const tokensSegment = `${formatTokens(tokens)} tokens`;
  const modeSegment = `mode: ${permissionMode}`;
  let bgSegment: string | null = null;
  if (backgroundTasks.length > 0) {
    const joined = backgroundTasks
      .map((label) => truncateToWidth(toTerminalSafe(label), BG_PER_LABEL_MAX))
      .join(", ");
    bgSegment = `bg: ${backgroundTasks.length} (${truncateToWidth(joined, BG_LABEL_MAX)})`;
  }
  const raw = [
    cwdSegment,
    bgSegment,
    modelSegment,
    ctxSegment,
    cacheSegment,
    costSegment,
    tokensSegment,
    modeSegment,
  ];
  const keys = ["cwd", "bg", "model", "ctx", "cache", "cost", "tokens", "mode"].filter(
    (_, index) => raw[index] != null,
  );
  const fitted = fitStatusSegments(raw, columns);
  return (
    <Box justifyContent="space-between">
      {fitted.map((segment, index) => (
        <Text
          key={keys[index]}
          color={keys[index] === "bg" ? "yellow" : undefined}
          dimColor={keys[index] !== "bg"}
        >
          {segment}
        </Text>
      ))}
    </Box>
  );
});
