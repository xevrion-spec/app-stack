// Scoped mutation run for the statement importers (OFX/QIF/MT940/CSV). `npx stryker run stryker.importers.config.mjs`
import base from "./stryker.config.mjs";
export default {
  ...base,
  mutate: ["packages/books/src/importers.ts"],
  vitest: { configFile: "vitest.mutation.importers.config.ts" },
  concurrency: 6,
  jsonReporter: { fileName: "reports/mutation/mutation-importers.json" },
  reporters: ["clear-text", "progress", "json"],
  tempDirName: ".stryker-tmp-importers",
};
