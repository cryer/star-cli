// The AI SDK's APICallError carries the raw response body; relays often put
// the real failure reason there while the message stays generic. Shared by
// the retry policy (llm/retry.ts) and the oversized-image detector
// (core/image.ts) — kept in core so neither has to import across layers.
export function responseBodyOf(error: Error): string | undefined {
  const body = (error as { responseBody?: unknown }).responseBody;
  return typeof body === "string" && body.length > 0 ? body : undefined;
}
