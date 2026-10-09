// Argument candidates for a command: a static list, or a function of the
// current argument prefix (last whitespace-separated token) for dynamic
// sources like the configured model names.
export type ArgHintSource = string[] | ((argPrefix: string) => string[]);

export interface SlashCommandHint {
  name: string;
  description: string;
  usage?: string;
  argHints?: ArgHintSource;
}

// Visible window size for the suggestion menu in InputBox and the path-
// suggestion cap — NOT a cap on reachable candidates: filtering returns every
// match and the menu windows around the highlight so arrows scroll them all.
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
  return [...prefixed, ...fuzzy];
}

// Up to 3 prefix-matched command names as a "Did you mean" hint, or "".
export function didYouMeanSuffix(names: string[]): string {
  if (names.length === 0) return "";
  const listed = names.slice(0, 3).map((name) => `/${name}`);
  return ` Did you mean: ${listed.join(", ")}?`;
}

export interface ArgHint {
  // The argument value being offered.
  value: string;
  // The full input text once this hint is accepted (current token replaced;
  // no trailing space, so accepting a hint never pops the next token's hints
  // over a user who just wants to submit).
  replacement: string;
}

// Argument completion for the "/cmd args..." shape: once the input names a
// command that declares argHints, offer its candidates filtered by the
// current (last) argument token. Commands without argHints get nothing, same
// as before. Only the trailing token is completed — anything earlier is kept
// verbatim.
export function filterArgHints(input: string, commands: SlashCommandHint[]): ArgHint[] {
  if (!input.startsWith("/")) return [];
  const spaceIndex = input.search(/\s/);
  if (spaceIndex === -1) return [];
  const name = input.slice(1, spaceIndex).toLowerCase();
  const command = commands.find((cmd) => cmd.name.toLowerCase() === name);
  if (!command?.argHints) return [];
  const tokenMatch = /\S+$/.exec(input.slice(spaceIndex));
  const argPrefix = tokenMatch ? tokenMatch[0] : "";
  const source = command.argHints;
  const candidates = typeof source === "function" ? source(argPrefix) : source;
  const prefix = argPrefix.toLowerCase();
  const stem = input.slice(0, input.length - argPrefix.length);
  return candidates
    .filter((candidate) => candidate.toLowerCase().startsWith(prefix))
    .map((value) => ({ value, replacement: `${stem}${value}` }));
}
