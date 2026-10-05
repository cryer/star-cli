import { createElement, useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import type { DisplayMessage } from "../src/cli/components/MessageList";
import { renderApp, stripAnsi, tick } from "./ink-harness";

// Dynamic import so ./ink-harness sets FORCE_COLOR before ink is loaded.
const { MessageList, collapseInitialMessages, INITIAL_RENDER_LIMIT } = await import(
  "../src/cli/components/MessageList"
);

// Zero-padded ids keep per-entry text free of substring collisions
// ("entry-0004" never appears inside "entry-0040" or "entry-0104").
function makeMessages(n: number): DisplayMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    role: "user" as const,
    text: `entry-${String(i).padStart(4, "0")}`,
  }));
}

// Appends `extra` to the list right after mount, mimicking a live turn.
function AppendHarness({ initial, extra }: { initial: DisplayMessage[]; extra: DisplayMessage[] }) {
  const [messages, setMessages] = useState(initial);
  useEffect(() => {
    setMessages((prev) => (prev.length > initial.length ? prev : [...prev, ...extra]));
  }, [initial.length, extra]);
  return createElement(MessageList, { messages });
}

describe("collapseInitialMessages", () => {
  it("returns the whole batch when it fits the limit", () => {
    const messages = makeMessages(5);
    const view = collapseInitialMessages(messages);
    expect(view.hidden).toBe(0);
    expect(view.visible).toEqual(messages);
  });

  it("does not collapse at exactly the limit", () => {
    const view = collapseInitialMessages(makeMessages(INITIAL_RENDER_LIMIT));
    expect(view.hidden).toBe(0);
    expect(view.visible).toHaveLength(INITIAL_RENDER_LIMIT);
  });

  it("keeps only the newest entries when over the limit", () => {
    const messages = makeMessages(INITIAL_RENDER_LIMIT + 5);
    const view = collapseInitialMessages(messages);
    expect(view.hidden).toBe(5);
    expect(view.visible).toHaveLength(INITIAL_RENDER_LIMIT);
    expect(view.visible[0]?.id).toBe(5);
    expect(view.visible.at(-1)?.id).toBe(INITIAL_RENDER_LIMIT + 4);
  });

  it("honors a custom limit", () => {
    const view = collapseInitialMessages(makeMessages(10), 3);
    expect(view.hidden).toBe(7);
    expect(view.visible.map((m) => m.id)).toEqual([7, 8, 9]);
  });
});

describe("MessageList initial-history collapse", () => {
  it("renders only the newest entries of a long initial history plus a placeholder", async () => {
    const app = renderApp(
      createElement(MessageList, { messages: makeMessages(INITIAL_RENDER_LIMIT + 5) }),
    );
    await tick();
    const output = stripAnsi(app.allOutput());
    expect(output).toContain("… 5 earlier messages hidden — full history in the session file");
    expect(output).toContain("entry-0005");
    expect(output).toContain(`entry-${String(INITIAL_RENDER_LIMIT + 4).padStart(4, "0")}`);
    expect(output).not.toContain("entry-0004");
    expect(output).not.toContain("entry-0000");
    app.unmount();
  });

  it("renders a short initial history in full without a placeholder", async () => {
    const app = renderApp(createElement(MessageList, { messages: makeMessages(3) }));
    await tick();
    const output = stripAnsi(app.allOutput());
    expect(output).not.toContain("earlier messages hidden");
    expect(output).toContain("entry-0000");
    expect(output).toContain("entry-0002");
    app.unmount();
  });

  it("renders post-mount appends in full and keeps the placeholder count fixed", async () => {
    const extra: DisplayMessage[] = [
      { id: INITIAL_RENDER_LIMIT + 3, role: "assistant", text: "live-turn-reply" },
      { id: INITIAL_RENDER_LIMIT + 4, role: "user", text: "live-turn-followup" },
    ];
    const app = renderApp(
      createElement(AppendHarness, {
        initial: makeMessages(INITIAL_RENDER_LIMIT + 3),
        extra,
      }),
    );
    await tick();
    await tick();
    const output = stripAnsi(app.allOutput());
    expect(output).toContain("… 3 earlier messages hidden — full history in the session file");
    expect(output).toContain("live-turn-reply");
    expect(output).toContain("live-turn-followup");
    // The collapse view is computed once from the initial batch: appending
    // never re-collapses (still 3 hidden, not 4 or 5).
    expect(output).not.toContain("4 earlier messages hidden");
    app.unmount();
  });

  it("adds no placeholder for a fresh session that only appends", async () => {
    const extra: DisplayMessage[] = [
      { id: 0, role: "user", text: "first live prompt" },
      { id: 1, role: "assistant", text: "first live reply" },
    ];
    const app = renderApp(createElement(AppendHarness, { initial: [], extra }));
    await tick();
    await tick();
    const output = stripAnsi(app.allOutput());
    expect(output).not.toContain("earlier messages hidden");
    expect(output).toContain("first live prompt");
    expect(output).toContain("first live reply");
    app.unmount();
  });
});
