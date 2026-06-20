import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry shims are thin wiring exercised only via end-to-end smoke runs.
      exclude: ["src/index.ts", "src/cli.ts"],
    },
  },
});
