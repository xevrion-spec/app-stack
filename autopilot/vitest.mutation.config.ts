import { defineConfig } from "vitest/config";
// Only the fast, pure unit suites that cover the mutated modules.
export default defineConfig({
  css: { postcss: {} },
  test: { include: ["packages/pipeline/test/**/*.test.ts", "packages/platform/test/**/*.test.ts"] },
});
