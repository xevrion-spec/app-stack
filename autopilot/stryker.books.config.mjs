// Scoped mutation run for the V3-V6 books modules (faster than the full nightly run). `npx stryker run stryker.books.config.mjs`
import base from "./stryker.config.mjs";
export default {
  ...base,
  mutate: ["packages/books/src/invoicing.ts", "packages/books/src/spikes.ts", "packages/books/src/assistant.ts", "packages/books/src/providers.ts"],
  vitest: { configFile: "vitest.mutation.books.config.ts" },
  concurrency: 6,
  jsonReporter: { fileName: "reports/mutation/mutation-books.json" },
  reporters: ["clear-text", "progress", "json"],
  tempDirName: ".stryker-tmp-books",
};
