import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    env: {
      STAR_NO_UPDATE_CHECK: "1",
    },
  },
});
