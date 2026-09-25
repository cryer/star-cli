import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { TodoItem } from "../src/tools/todo";
import { renderApp, stripAnsi, tick } from "./ink-harness";

const { MAX_VISIBLE_TODOS, TodoPanel, visibleTodoWindow } = await import(
  "../src/cli/components/TodoPanel"
);

const makeTodos = (n: number, activeIndex = -1): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `task ${i + 1}`,
    status: i === activeIndex ? ("in_progress" as const) : ("pending" as const),
  }));

describe("visibleTodoWindow", () => {
  it("returns the whole list when it fits", () => {
    const todos = makeTodos(3);
    const win = visibleTodoWindow(todos);
    expect(win.items.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(win.hiddenBefore).toBe(0);
    expect(win.hiddenAfter).toBe(0);
  });

  it("caps at max and reports the hidden tail when nothing is active", () => {
    const win = visibleTodoWindow(makeTodos(15));
    expect(win.items).toHaveLength(MAX_VISIBLE_TODOS);
    expect(win.hiddenBefore).toBe(0);
    expect(win.hiddenAfter).toBe(5);
  });

  it("keeps the in-progress item inside a full window", () => {
    const win = visibleTodoWindow(makeTodos(20, 12));
    expect(win.items.some((t) => t.status === "in_progress")).toBe(true);
    expect(win.items).toHaveLength(MAX_VISIBLE_TODOS);
    expect(win.hiddenBefore).toBe(20 - MAX_VISIBLE_TODOS);
    expect(win.hiddenAfter).toBe(0);
  });

  it("clamps the window to the list end when the active item is near the tail", () => {
    const win = visibleTodoWindow(makeTodos(12, 11));
    expect(win.items.at(-1)?.status).toBe("in_progress");
    expect(win.hiddenAfter).toBe(0);
    expect(win.hiddenBefore).toBe(12 - MAX_VISIBLE_TODOS);
  });
});

describe("TodoPanel", () => {
  it("renders overflow markers instead of every item", async () => {
    const app = renderApp(createElement(TodoPanel, { todos: makeTodos(15) }));
    await tick();
    const frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toContain("task 1");
    expect(frame).toContain(`task ${MAX_VISIBLE_TODOS}`);
    expect(frame).not.toContain(`task ${MAX_VISIBLE_TODOS + 1}`);
    expect(frame).toContain("5 more");
    app.unmount();
  });
});
