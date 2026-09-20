import { describe, expect, it } from "vitest";
import { type UpdateFetcher, checkForUpdate, isNewerVersion } from "../src/cli/update-check";

describe("isNewerVersion", () => {
  it("detects newer versions", () => {
    expect(isNewerVersion("0.2.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.2", "0.1.1")).toBe(true);
  });

  it("rejects older or equal versions", () => {
    expect(isNewerVersion("0.1.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
  });
});

function fakeFetcher(body: unknown, ok = true): UpdateFetcher {
  return async () => ({ ok, json: async () => body });
}

describe("checkForUpdate", () => {
  it("returns a notice when a newer version exists", async () => {
    const message = await checkForUpdate("0.1.1", fakeFetcher({ version: "0.2.0" }));
    expect(message).toBe("New version available: 0.1.1 -> 0.2.0 — run: npm i -g @cryer/star-cli");
  });

  it("returns null when already up to date", async () => {
    expect(await checkForUpdate("0.2.0", fakeFetcher({ version: "0.2.0" }))).toBeNull();
    expect(await checkForUpdate("0.2.0", fakeFetcher({ version: "0.1.0" }))).toBeNull();
  });

  it("returns null on non-2xx responses", async () => {
    expect(await checkForUpdate("0.1.1", fakeFetcher({ version: "9.9.9" }, false))).toBeNull();
  });

  it("returns null when the payload has no version string", async () => {
    expect(await checkForUpdate("0.1.1", fakeFetcher({}))).toBeNull();
  });

  it("returns null when the fetch fails", async () => {
    const failing: UpdateFetcher = async () => {
      throw new Error("network down");
    };
    expect(await checkForUpdate("0.1.1", failing)).toBeNull();
  });
});
