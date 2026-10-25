import { defineConfig } from "vitest/config";
// Books unit suites only (used by stryker.books.config.mjs).
export default defineConfig({ css: { postcss: {} }, test: { include: ["packages/books/test/**/*.test.ts"] } });
