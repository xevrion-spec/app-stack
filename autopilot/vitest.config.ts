import { defineConfig } from "vitest/config";
export default defineConfig({
  css: { postcss: {} },
  test: {
    testTimeout: 20_000, // slow dev machines under full parallel load
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "apps/**/test/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "apps/web/e2e/**"],
    coverage: {
      provider: "v8",
      include: ["packages/pipeline/src/**", "packages/books/src/**", "packages/platform/src/**", "packages/agent-review/src/**", "packages/sdk/src/**", "apps/api/src/**"],
      exclude: ["apps/api/src/index.ts", "apps/api/src/env.ts", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
