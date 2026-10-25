import { defineConfig } from "vitest/config";
export default defineConfig({
  css: { postcss: {} },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "apps/web/e2e/**"],
    coverage: { provider: "v8", include: ["packages/pipeline/src/**", "apps/api/src/**"], reporter: ["text-summary", "json-summary"], reportsDirectory: "coverage", thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 } },
  },
});
