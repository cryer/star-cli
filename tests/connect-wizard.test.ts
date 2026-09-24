import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

// FORCE_COLOR is set by ./ink-harness before ink is loaded (static import above),
// so this dynamic import of ConnectWizard (which imports ink) sees colored output.
const { ConnectWizard } = await import("../src/cli/components/ConnectWizard");

const ENTER = "\r";
const ESC = "";
const DOWN = "[B";

const API_KEY = "sk-test-key-987654";

function setup(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn(async () => "saved ok");
  const onSetDefault = vi.fn(async () => "default ok");
  const onOpenConfig = vi.fn(() => "opened ok");
  const onFinish = vi.fn();
  const onCancel = vi.fn();
  const app = renderApp(
    createElement(ConnectWizard, {
      existingProviderNames: [],
      existingModelNames: [],
      onSave,
      onSetDefault,
      onOpenConfig,
      onFinish,
      onCancel,
      ...overrides,
    }),
  );
  return { app, onSave, onSetDefault, onOpenConfig, onFinish, onCancel };
}

const frame = (app: { lastFrame(): string | undefined }) => stripAnsi(app.lastFrame() ?? "");

describe("ConnectWizard", () => {
  it("runs the full preset flow, masks the key everywhere, and finishes", async () => {
    const { app, onSave, onSetDefault, onOpenConfig, onFinish } = setup();

    // 1. provider picker
    await tick();
    expect(frame(app)).toContain("Which provider?");
    expect(frame(app)).toContain("OpenAI");
    expect(frame(app)).toContain("Custom");
    await typeText(app.stdin, ENTER);

    // 2. baseURL prefilled with the preset default
    expect(frame(app)).toContain("baseURL:");
    expect(frame(app)).toContain("https://api.openai.com/v1");
    await typeText(app.stdin, ENTER);

    // 3. API key entry echoes bullets, never the key
    expect(frame(app)).toContain("API key:");
    await typeText(app.stdin, API_KEY);
    expect(frame(app)).toContain("••••");
    expect(frame(app)).not.toContain(API_KEY);
    await typeText(app.stdin, ENTER);

    // 4. model id
    expect(frame(app)).toContain("Model id:");
    await typeText(app.stdin, "gpt-4o", ENTER);

    // 5. confirmation summary with masked key
    const summary = frame(app);
    expect(summary).toContain("provider:  openai (openai-compatible)");
    expect(summary).toContain("STAR_API_KEY_OPENAI");
    expect(summary).toContain("sk-…7654");
    expect(summary).not.toContain(API_KEY);
    await typeText(app.stdin, "y");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      providerName: "openai",
      protocol: "openai-compatible",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "STAR_API_KEY_OPENAI",
      apiKey: API_KEY,
      modelName: "gpt-4o",
      modelId: "gpt-4o",
    });
    await vi.waitFor(() => expect(frame(app)).toContain('Set "gpt-4o" as the default model'));

    // 6. set as default
    await typeText(app.stdin, "y");
    await vi.waitFor(() => expect(onSetDefault).toHaveBeenCalledWith("gpt-4o"));
    await vi.waitFor(() => expect(frame(app)).toContain("Open the config file now?"));

    // 7. open the config file, then the wizard finishes
    await typeText(app.stdin, "y");
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
    const message = onFinish.mock.calls[0]?.[0] as string;
    expect(message).toContain("saved ok");
    expect(message).toContain("default ok");
    expect(message).toContain("opened ok");
    expect(message).not.toContain(API_KEY);
    app.unmount();
  });

  it("walks the custom flow through the protocol step and derives names", async () => {
    const onSave = vi.fn(async () => "saved ok");
    const { app, onCancel } = setup({ onSave });

    await tick();
    // move past the 4 presets onto Custom
    await typeText(app.stdin, DOWN, DOWN, DOWN, DOWN, ENTER);
    expect(frame(app)).toContain("API format (protocol)?");
    await typeText(app.stdin, ENTER); // openai-compatible (first option)

    expect(frame(app)).toContain("baseURL:");
    await typeText(app.stdin, "https://relay.example.com/v1", ENTER);
    expect(frame(app)).toContain("API key:");
    await typeText(app.stdin, API_KEY, ENTER);
    expect(frame(app)).toContain("Model id:");
    await typeText(app.stdin, "my-model", ENTER);

    const summary = frame(app);
    expect(summary).toContain("provider:  relay (openai-compatible)");
    expect(summary).toContain("STAR_API_KEY_RELAY");
    // answering n on the confirmation cancels without saving
    await typeText(app.stdin, "n");
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
    app.unmount();
  });

  it("accepts a bracketed paste in the baseURL field and stays editable", async () => {
    const onSave = vi.fn(async () => "saved ok");
    const { app } = setup({ onSave });

    await tick();
    await typeText(app.stdin, DOWN, DOWN, DOWN, DOWN, ENTER); // Custom
    await typeText(app.stdin, ENTER); // openai-compatible
    expect(frame(app)).toContain("baseURL:");

    await typeText(app.stdin, "\u001B[200~https://api.example.com/v11\u001B[201~");
    const shown = frame(app);
    expect(shown).toContain("https://api.example.com/v11");
    expect(shown).not.toContain("200~");

    // still editable after the paste: drop the stray digit, then submit
    await typeText(app.stdin, "\x7f", ENTER);
    await typeText(app.stdin, API_KEY, ENTER);
    await typeText(app.stdin, "my-model", ENTER);
    const summary = frame(app);
    expect(summary).toContain("baseURL:   https://api.example.com/v1");
    app.unmount();
  });

  it("dedupes provider and model names against existing entries", async () => {
    const onSave = vi.fn(async () => "saved ok");
    const { app } = setup({
      onSave,
      existingProviderNames: ["openai"],
      existingModelNames: ["gpt-4o"],
    });

    await tick();
    await typeText(app.stdin, ENTER); // OpenAI preset
    await typeText(app.stdin, ENTER); // default baseURL
    await typeText(app.stdin, API_KEY, ENTER);
    await typeText(app.stdin, "gpt-4o", ENTER);
    const summary = frame(app);
    expect(summary).toContain("provider:  openai-2");
    expect(summary).toContain("STAR_API_KEY_OPENAI_2");
    expect(summary).toContain("model:     gpt-4o-2 → gpt-4o");
    app.unmount();
  });

  it("cancels with Esc at the first step and saves nothing", async () => {
    const { app, onSave, onCancel } = setup();
    await tick();
    await typeText(app.stdin, ESC);
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
    app.unmount();
  });

  it("stays on the API key step when submitted empty", async () => {
    const { app } = setup();
    await tick();
    await typeText(app.stdin, ENTER); // OpenAI preset
    await typeText(app.stdin, ENTER); // default baseURL
    expect(frame(app)).toContain("API key:");
    await typeText(app.stdin, ENTER); // empty submit rejected
    expect(frame(app)).toContain("API key is required");
    expect(frame(app)).toContain("API key:");
    app.unmount();
  });
});
