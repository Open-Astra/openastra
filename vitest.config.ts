import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: [
        "src/agents/**/*.ts",
        "src/events/**/*.ts",
        "src/inference/**/*.ts",
        "src/memory/**/*.ts",
        "src/security/**/*.ts",
        "src/tools/**/*.ts",
        "src/gateway/middleware/**/*.ts",
      ],
      exclude: [
        "src/**/__tests__/**",
        "src/**/types.ts",
        "src/**/index.ts",
        "src/db/migrations/**",
        "src/data/migrations/**",
      ],
    },
  },
});
