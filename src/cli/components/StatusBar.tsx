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
const BG_LABEL_MIN = 8;
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
  // The bg segment gets whatever width the other segments leave; labels are
  // dropped entirely when there is no room, so the bar never wraps.
  let bgSegment: string | null = null;
  if (backgroundTasks.length > 0) {
    const prefix = `bg: ${backgroundTasks.length}`;
    const others = [
      cwdSegment,
      modelSegment,
      ctxSegment,
      cacheSegment,
      costSegment,
      tokensSegment,
      modeSegment,
    ].filter((s): s is string => s != null);
    const fixed = others.reduce((total, s) => total + displayWidth(s), 0);
    const gaps = others.length; // one space per neighbour pair, bg included
    const budget = columns - fixed - gaps - displayWidth(prefix) - 2; // 2 for " (" + ")"
    bgSegment = prefix;
    if (budget >= BG_LABEL_MIN) {
      // Task commands/descriptions are model-influenced; escape before display.
      const joined = backgroundTasks
        .map((label) => truncateToWidth(toTerminalSafe(label), BG_PER_LABEL_MAX))
        .join(", ");
      bgSegment = `${prefix} (${truncateToWidth(joined, Math.min(budget, BG_LABEL_MAX))})`;
    }
  }
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{cwdSegment}</Text>
      {bgSegment && <Text color="yellow">{bgSegment}</Text>}
      <Text dimColor>{modelSegment}</Text>
      {ctxSegment && <Text dimColor>{ctxSegment}</Text>}
      <Text dimColor>{cacheSegment}</Text>
      {costSegment && <Text dimColor>{costSegment}</Text>}
      <Text dimColor>{tokensSegment}</Text>
      <Text dimColor>{modeSegment}</Text>
    </Box>
  );
});
