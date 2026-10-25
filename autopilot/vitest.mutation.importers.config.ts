import { defineConfig } from "vitest/config";
// Importer suites only (used by stryker.importers.config.mjs).
export default defineConfig({ css: { postcss: {} }, test: { include: ["packages/books/test/importers*.test.ts", "packages/books/test/importers.mutation.test.ts", "packages/books/test/branches.test.ts", "packages/books/test/golden.test.ts"] } });
