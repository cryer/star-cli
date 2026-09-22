import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // integration-heavy suite (real git, Ink rendering, real fs) on slow shared CI runners
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      STAR_NO_UPDATE_CHECK: "1",
    },
  },
});
