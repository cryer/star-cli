import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UpdateFetcher, checkForUpdate } from "../src/cli/update-check";
import { rmWithRetry } from "./test-fs";

const DAY_MS = 24 * 60 * 60 * 1000;

function countingFetcher(body: unknown, ok = true) {
  let calls = 0;
  const fetcher: UpdateFetcher = async () => {
    calls++;
    return { ok, json: async () => body };
  };
  return { fetcher, calls: () => calls };
}

describe("checkForUpdate throttling", () => {
  let home: string;
  let statePath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-update-throttle-"));
    vi.stubEnv("STAR_HOME", home);
    statePath = path.join(home, "update-check.json");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmWithRetry(home);
  });

  function writeState(state: unknown) {
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  }

  it("does not fetch within the throttle window and replays the cached notice", async () => {
    writeState({ lastCheckAt: Date.now(), latest: "9.9.9" });
    const { fetcher, calls } = countingFetcher({ version: "0.0.1" });
    const message = await checkForUpdate("0.1.1", fetcher);
    expect(calls()).toBe(0);
    expect(message).toBe("New version available: 0.1.1 -> 9.9.9 — run: npm i -g @cryer/star-cli");
  });

  it("stays silent within the window when the cached version is not newer", async () => {
    writeState({ lastCheckAt: Date.now(), latest: "0.1.0" });
    const { fetcher, calls } = countingFetcher({ version: "9.9.9" });
    expect(await checkForUpdate("0.2.0", fetcher)).toBeNull();
    expect(calls()).toBe(0);
  });

  it("fetches again once the window has passed and rewrites the state file", async () => {
    writeState({ lastCheckAt: Date.now() - DAY_MS - 60_000, latest: "0.1.1" });
    const { fetcher, calls } = countingFetcher({ version: "0.3.0" });
    const before = Date.now();
    const message = await checkForUpdate("0.1.1", fetcher);
    expect(calls()).toBe(1);
    expect(message).toBe("New version available: 0.1.1 -> 0.3.0 — run: npm i -g @cryer/star-cli");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.latest).toBe("0.3.0");
    expect(state.lastCheckAt).toBeGreaterThanOrEqual(before);
  });

  it("treats a corrupt state file as never checked and recovers silently", async () => {
    fs.writeFileSync(statePath, "not json {{{", "utf8");
    const { fetcher, calls } = countingFetcher({ version: "0.2.0" });
    const message = await checkForUpdate("0.1.1", fetcher);
    expect(calls()).toBe(1);
    expect(message).toBe("New version available: 0.1.1 -> 0.2.0 — run: npm i -g @cryer/star-cli");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.latest).toBe("0.2.0");
  });

  it("caches a successful check so the next startup stays offline", async () => {
    const { fetcher, calls } = countingFetcher({ version: "0.2.0" });
    expect(await checkForUpdate("0.1.1", fetcher)).not.toBeNull();
    expect(calls()).toBe(1);
    const second = await checkForUpdate("0.1.1", fetcher);
    expect(calls()).toBe(1);
    expect(second).toBe("New version available: 0.1.1 -> 0.2.0 — run: npm i -g @cryer/star-cli");
  });

  it("does not write state when the fetch fails, so the next startup retries", async () => {
    const failing: UpdateFetcher = async () => {
      throw new Error("network down");
    };
    expect(await checkForUpdate("0.1.1", failing)).toBeNull();
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
