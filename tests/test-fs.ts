import fs from "node:fs";

// Session meta writes are debounced (2s flush timer) and fire-and-forget, so
// they can still be mid tmp+rename when a test's teardown runs; on Windows a
// plain rmSync then loses the race with ENOTEMPTY/EBUSY/EPERM. Retry over a
// window longer than the flush debounce instead of flaking.
export async function rmWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!transient || attempt >= 24) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
