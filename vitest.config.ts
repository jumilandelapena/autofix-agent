import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["demo-repo/**", "runs/**", "node_modules/**"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 300_000,
    env: {
      LLM_PROVIDER: "mock",
    },
  },
});
