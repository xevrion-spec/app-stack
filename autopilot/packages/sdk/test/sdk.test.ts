import { it, expect } from "vitest";
import { createSdk } from "../src/index.js";
import { makeEnv } from "../../../apps/api/test/harness.js";
import { createApp } from "../../../apps/api/src/app.js";

it("SDK talks to the real app with typed calls and auto idempotency keys", async () => {
  const { env } = makeEnv();
  const app = createApp();
  const sdk = createSdk({ baseUrl: "http://api.test", devUser: "sdk@example.test", fetch: (r) => Promise.resolve(app.request(r as Request, undefined, env)) });
  const t = await sdk.POST("/v1/tenants", { body: { name: "SDK Ltd test", vatRegistered: false, vatScheme: null, flatRatePercent: null } });
  expect(t.response.status).toBe(201);
  const me = await sdk.GET("/v1/me");
  expect(me.data?.tenantId).toBe(t.data?.id);
  const cats = await sdk.GET("/v1/categories");
  expect(cats.data?.length).toBeGreaterThan(5);
});
