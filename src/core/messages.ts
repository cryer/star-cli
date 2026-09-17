import type { CoreMessage } from "ai";

export type { CoreMessage };

export interface ConversationState {
  messages: CoreMessage[];
}
