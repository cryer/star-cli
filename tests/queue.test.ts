import { describe, expect, it } from "vitest";
import { PromptQueue } from "../src/cli/queue";

const img = { path: "clipboard.png", mimeType: "image/png", data: "AAAA" };

describe("PromptQueue", () => {
  it("dequeues in FIFO order", () => {
    const queue = new PromptQueue();
    queue.enqueue({ text: "first", images: [] });
    queue.enqueue({ text: "second", images: [img] });
    expect(queue.size).toBe(2);
    expect(queue.dequeue()?.text).toBe("first");
    expect(queue.dequeue()?.images).toEqual([img]);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("enqueue returns the new length", () => {
    const queue = new PromptQueue();
    expect(queue.enqueue({ text: "a", images: [] })).toBe(1);
    expect(queue.enqueue({ text: "b", images: [] })).toBe(2);
  });

  it("clear empties the queue and returns the dropped prompts", () => {
    const queue = new PromptQueue();
    queue.enqueue({ text: "a", images: [] });
    queue.enqueue({ text: "b", images: [] });
    const cleared = queue.clear();
    expect(cleared.map((p) => p.text)).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("list returns a copy that does not mutate the queue", () => {
    const queue = new PromptQueue();
    queue.enqueue({ text: "a", images: [] });
    const listed = queue.list();
    listed.pop();
    expect(queue.size).toBe(1);
  });
});
