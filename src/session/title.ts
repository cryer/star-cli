import { type LanguageModel, generateText } from "ai";
import type { SessionStore } from "./store";

const TITLE_MAX_CHARS = 50;
const TITLE_INPUT_MAX_CHARS = 1000;
const TITLE_MAX_TOKENS = 20;
const TITLE_TIMEOUT_MS = 15_000;

const TITLE_SYSTEM_PROMPT = [
  "You write short titles for conversations.",
  "Summarize the user's first message into a single concise title:",
  "- at most 50 characters",
  "- no surrounding quotes, no trailing punctuation",
  "- same language as the user's message",
  "Output only the title, nothing else.",
].join("\n");

function sanitizeTitle(raw: string): string {
  let title = raw.trim().split("\n")[0]?.trim() ?? "";
  let previous: string;
  do {
    previous = title;
    title = title
      .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/g, "")
      .replace(/[。．.!！?？…:：;；,，、\s]+$/u, "");
  } while (title !== previous);
  return title.slice(0, TITLE_MAX_CHARS).trim();
}

export async function generateSessionTitle(
  userText: string,
  model: LanguageModel,
): Promise<string> {
  const { text } = await generateText({
    model,
    system: TITLE_SYSTEM_PROMPT,
    prompt: userText.slice(0, TITLE_INPUT_MAX_CHARS),
    maxTokens: TITLE_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
  });
  return sanitizeTitle(text);
}

// Fire-and-forget title generation: never throws, never blocks the caller,
// and skips sessions that already have a title. An unfinished request is
// bounded by TITLE_TIMEOUT_MS and may simply be dropped when the process
// exits — the title just stays empty.
export function scheduleSessionTitle(
  store: SessionStore,
  userText: string,
  model: LanguageModel,
): void {
  void (async () => {
    const meta = await store.meta();
    if (meta.title) return;
    const title = await generateSessionTitle(userText, model);
    if (!title) return;
    const current = await store.meta();
    if (current.title) return;
    await store.setTitle(title);
  })().catch(() => {});
}
