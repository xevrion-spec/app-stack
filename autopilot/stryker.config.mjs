// Mutation testing on the money-critical and automation cores. `npm run mutation` (CI: nightly + on changes to these files).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  mutate: [
    "packages/pipeline/src/ledger.ts",
    "packages/pipeline/src/vat.ts",
    "packages/pipeline/src/categorise.ts",
    "packages/platform/src/automation.ts",
    "packages/platform/src/webhooks.ts",
    "packages/books/src/tax.ts",
    "packages/books/src/calculators.ts",
    "packages/books/src/duplicates.ts",
  ],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 85, low: 75, break: 70 },
  concurrency: 2,
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
};
