export const BELL = "\x07";

export interface NotifyBellInput {
  enabled: boolean;
  thresholdSec: number;
  noNotifyEnv: boolean;
  interrupted?: boolean;
  // Turn duration; omit for events with no meaningful threshold (background
  // task completion always qualifies).
  elapsedMs?: number;
}

export function shouldNotifyBell(input: NotifyBellInput, isTTY: boolean): boolean {
  if (!input.enabled || input.noNotifyEnv || !isTTY) return false;
  if (input.interrupted) return false;
  if (input.elapsedMs !== undefined && input.elapsedMs < input.thresholdSec * 1000) return false;
  return true;
}

export interface NotifyBellDeps {
  write?: (text: string) => void;
  isTTY?: boolean;
}

export function notifyBell(input: NotifyBellInput, deps: NotifyBellDeps = {}): boolean {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (!shouldNotifyBell(input, isTTY)) return false;
  (deps.write ?? ((text: string) => process.stdout.write(text)))(BELL);
  return true;
}
