export interface SlashCommandHint {
  name: string;
  description: string;
  usage?: string;
}

export const MAX_SUGGESTIONS = 5;

function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (const ch of target) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

export function filterCommands(input: string, commands: SlashCommandHint[]): SlashCommandHint[] {
  if (!input.startsWith("/")) return [];
  if (/\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  const byName = (a: SlashCommandHint, b: SlashCommandHint) => a.name.localeCompare(b.name);
  const prefixed = commands.filter((cmd) => cmd.name.toLowerCase().startsWith(prefix)).sort(byName);
  const fuzzy = commands
    .filter(
      (cmd) =>
        !cmd.name.toLowerCase().startsWith(prefix) && isSubsequence(prefix, cmd.name.toLowerCase()),
    )
    .sort(byName);
  return [...prefixed, ...fuzzy].slice(0, MAX_SUGGESTIONS);
}

// Up to 3 prefix-matched command names as a "Did you mean" hint, or "".
export function didYouMeanSuffix(names: string[]): string {
  if (names.length === 0) return "";
  const listed = names.slice(0, 3).map((name) => `/${name}`);
  return ` Did you mean: ${listed.join(", ")}?`;
}
