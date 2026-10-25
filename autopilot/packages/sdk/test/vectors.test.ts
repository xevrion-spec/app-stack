import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { signPayload } from "@xevrion/platform";
import { verifyCallback } from "../src/index.js";

/** Cross-language contract: the server signer, the TS SDK verifier and the Python SDK (tests/test_client.py) agree byte for byte. */
it("server signer and SDK verifier match the shared Python vector", async () => {
  const v = JSON.parse(readFileSync(new URL("../../../sdks/python/tests/vectors.json", import.meta.url), "utf8")) as {
    secret: string;
    timestamp: number;
    body: string;
    header: string;
  };
  expect(await signPayload(v.secret, v.body, v.timestamp)).toBe(v.header);
  expect((await verifyCallback(v.body, v.header, [v.secret], { nowSeconds: v.timestamp })).data.requestId).toBe("r_1");
});
