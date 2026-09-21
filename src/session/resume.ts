import { type CoreMessage, reconcileToolCalls } from "../core/messages";
import { type SessionMeta, SessionStore } from "./store";

export async function resumeSession(
  id: string,
): Promise<{ meta: SessionMeta; messages: CoreMessage[] } | null> {
  const store = await SessionStore.open(id);
  if (!store) return null;
  const [meta, loaded] = await Promise.all([store.meta(), store.messages()]);
  const messages = reconcileToolCalls(loaded);
  if (messages.length !== loaded.length) {
    await store.replaceMessages(messages);
  }
  return { meta, messages };
}
