import type { CoreMessage } from "../core/messages";
import { estimateMessageTokens } from "./tokens";

// Incremental counterpart of estimateTokens for append-mostly histories.
// Messages must remain immutable while registered, matching the estimator's
// identity-keyed cache; call reset after compaction or any wholesale rewrite.
export class IncrementalTokenSummary {
  private messageTotal = 0;
  private count = 0;
  private overhead = 0;

  constructor(messages: readonly CoreMessage[] = [], overheadTokens = 0) {
    this.reset(messages, overheadTokens);
  }

  append(message: CoreMessage): number {
    this.messageTotal += estimateMessageTokens(message);
    this.count++;
    return this.totalTokens;
  }

  reset(messages: readonly CoreMessage[] = [], overheadTokens = this.overhead): void {
    this.messageTotal = 0;
    this.count = 0;
    this.overhead = overheadTokens;
    for (const message of messages) this.append(message);
  }

  setOverheadTokens(overheadTokens: number): void {
    this.overhead = overheadTokens;
  }

  get messageCount(): number {
    return this.count;
  }

  get messageTokens(): number {
    return this.messageTotal;
  }

  get overheadTokens(): number {
    return this.overhead;
  }

  get totalTokens(): number {
    return this.messageTotal + this.overhead;
  }
}
