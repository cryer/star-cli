import { Box, Text, useStdout } from "ink";
import { memo } from "react";
import { formatDollars } from "../cost";

interface StatusBarProps {
  cwd: string;
  model: string;
  permissionMode: string;
  tokens: number;
  // Git branch, refreshed on turn boundaries by the parent (null = not a repo).
  gitBranch?: string | null;
  // Context window usage in percent; null when unknown (non-loop backend).
  contextPercent?: number | null;
  // Prompt cache hit rate 0-100; null when the provider never reported cache
  // fields (rendered as "Not provided").
  cachePercent?: number | null;
  sessionCostUsd?: number | null;
  // Labels of currently running background tasks (description or command).
  backgroundTasks?: string[];
}

const BG_LABEL_MAX = 40;
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
  cachePercent,
  sessionCostUsd,
  backgroundTasks = [],
}: StatusBarProps) {
  const { stdout } = useStdout();
  const wide = (stdout?.columns ?? 80) >= WIDE_COLUMNS;
  const joined = backgroundTasks.join(", ");
  const labels = joined.length > BG_LABEL_MAX ? `${joined.slice(0, BG_LABEL_MAX)}…` : joined;
  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {cwdLabel(cwd, wide)}
        {gitBranch ? ` [${gitBranch}]` : ""}
      </Text>
      {backgroundTasks.length > 0 && (
        <Text color="yellow">
          bg: {backgroundTasks.length} ({labels})
        </Text>
      )}
      <Text dimColor>model: {model}</Text>
      {contextPercent != null && <Text dimColor>ctx: {contextPercent}%</Text>}
      <Text dimColor>cache: {cachePercent != null ? `${cachePercent}%` : "Not provided"}</Text>
      {sessionCostUsd != null && sessionCostUsd > 0 && (
        <Text dimColor>${formatDollars(sessionCostUsd)}</Text>
      )}
      <Text dimColor>{tokens} tokens</Text>
      <Text dimColor>mode: {permissionMode}</Text>
    </Box>
  );
});
