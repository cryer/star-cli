export interface SlashCommandHint {
  name: string;
  description: string;
}

export const MAX_SUGGESTIONS = 5;

export function filterCommands(input: string, commands: SlashCommandHint[]): SlashCommandHint[] {
  if (!input.startsWith("/")) return [];
  if (/\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  return commands
    .filter((cmd) => cmd.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS);
}
