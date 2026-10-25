// Scoped mutation run for the agent review core (state machine, policy engine, ledger, receipts). `npx stryker run stryker.agent-review.config.mjs`
import base from "./stryker.config.mjs";
export default {
  ...base,
  mutate: ["packages/agent-review/src/*.ts", "!packages/agent-review/src/index.ts"],
  vitest: { configFile: "vitest.mutation.agent-review.config.ts" },
  concurrency: 6,
  jsonReporter: { fileName: "reports/mutation/mutation-agent-review.json" },
  reporters: ["clear-text", "progress", "json"],
  tempDirName: ".stryker-tmp-agent-review",
};
