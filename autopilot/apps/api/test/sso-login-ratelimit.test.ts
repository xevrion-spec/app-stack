import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { __setRateLimitClock } from "../src/lib/ratelimit.js";

afterEach(() => __setRateLimitClock(null));
const start = "/sso/oidc/start?tenant=t-none&redirectUri=https%3A%2F%2Fapp.example.test%2Fcb";

describe("public SSO login rate limit", () => {
  it("throttles per client IP, isolates other IPs, refills over time, and covers the callback", async () => {
    let t = 1_000_000;
    __setRateLimitClock(() => t);
    const { env } = makeEnv({ RATE_LIMIT_LOGIN_PER_MINUTE: "3" });
    const call = client(env);
    const a = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < 3; i++) expect((await call("GET", start, { headers: a })).status).not.toBe(429);
    const blocked = await call("GET", start, { headers: a });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await call("POST", "/sso/oidc/callback", { headers: a, body: {} })).status).toBe(429);
    expect((await call("GET", start, { headers: { "cf-connecting-ip": "203.0.113.9" } })).status).not.toBe(429);
    t += 20_000;
    expect((await call("GET", start, { headers: a })).status).not.toBe(429);
  });
  it("defaults to 20/min and buckets requests with no IP together", async () => {
    __setRateLimitClock(() => 5);
    const call = client(makeEnv().env);
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await call("GET", start)).status);
    expect(codes.slice(0, 20)).not.toContain(429);
    expect(codes[20]).toBe(429);
  });
});
