import { describe, it, expect, vi, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";

// Regression: revocation used SQLite's clock while auth compares against the isolate clock. On Windows SQLite read
// up to 2 ms ahead (29% of samples), so a key used straight after DELETE still authenticated. Here the JS clock runs
// 1 s behind SQLite, which makes the old bug deterministic.
describe("API key revocation clock", () => {
  afterEach(() => vi.useRealTimers());
  it("a revoked key is rejected immediately even when the DB clock runs ahead of the isolate clock", async () => {
    const { env } = makeEnv();
    const call = client(env);
    const A = "owner-clock@example.test";
    await call("POST", "/v1/tenants", { user: A, body: { name: "Clock Co (synthetic)" } });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 1000 });
    const k = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["transactions:read"] } })).json as { id: string; key: string };
    const auth = { authorization: `Bearer ${k.key}` };
    expect((await call("GET", "/v1/transactions", { headers: auth })).status).toBe(200);
    expect((await call("DELETE", `/v1/api-keys/${k.id}`, { user: A })).status).toBe(200);
    expect((await call("GET", "/v1/transactions", { headers: auth })).status).toBe(401);
  });
});
