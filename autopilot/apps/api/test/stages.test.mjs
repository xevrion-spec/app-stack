import { test } from "node:test"; import assert from "node:assert";
import fs from "node:fs";
test("pipeline stages declared in order", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /"intake","extract","categorise","reconcile","draft","qa","review","deliver","outcome"/);
});
