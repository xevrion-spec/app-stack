import { defineConfig } from "vitest/config";
// Agent review core unit suites only (used by stryker.agent-review.config.mjs).
export default defineConfig({ css: { postcss: {} }, test: { include: ["packages/agent-review/test/**/*.test.ts"] } });
