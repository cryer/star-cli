export function summarizeArgs(args: unknown, maxLength = 120): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? String(args);
  } catch {
    json = String(args);
  }
  return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
}

export function previewLines(text: string, maxLines = 10): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}
