import type { ImageInput } from "../core/messages";

export interface QueuedPrompt {
  // Stable id for keyed rendering of the queued list.
  id: number;
  text: string;
  images: ImageInput[];
}

// FIFO typeahead queue: prompts submitted while a turn is streaming wait here
// and are auto-sent (in order) once the turn finishes.
export class PromptQueue {
  private items: QueuedPrompt[] = [];
  private nextId = 1;

  enqueue(prompt: { text: string; images: ImageInput[] }): number {
    this.items.push({ id: this.nextId++, ...prompt });
    return this.items.length;
  }

  dequeue(): QueuedPrompt | undefined {
    return this.items.shift();
  }

  // Empties the queue and returns what was dropped (for the "cleared N" note).
  clear(): QueuedPrompt[] {
    const removed = this.items;
    this.items = [];
    return removed;
  }

  get size(): number {
    return this.items.length;
  }

  list(): QueuedPrompt[] {
    return [...this.items];
  }
}
