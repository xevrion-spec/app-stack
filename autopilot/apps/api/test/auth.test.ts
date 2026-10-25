import { describe, it, expect, afterAll } from "vitest";
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from "jose";
import { makeEnv, client } from "./harness.js";
import { __setAccessKeyForTests } from "../src/lib/auth.js";

const TEAM = "example.cloudflareaccess.com",
  AUD = "test-aud";

describe("Cloudflare Access JWT", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  __setAccessKeyForTests(createLocalJWKSet({ keys: [jwk] }));
  afterAll(() => __setAccessKeyForTests(null));
  const sign = (claims: Record<string, unknown>, aud = AUD, exp = "5m") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(aud)
      .setSubject("sub-1")
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  const env = () => makeEnv({ ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }).env;

  it("accepts a valid token and bootstraps a tenant", async () => {
    const call = client(env());
    const h = { "cf-access-jwt-assertion": await sign({ email: "Owner@Example.test" }) };
    expect((await call("POST", "/v1/tenants", { body: { name: "JWT Co" }, headers: h })).status).toBe(201);
    const me = await call("GET", "/v1/me", { headers: h });
    expect(me.json.email).toBe("owner@example.test");
  });
  it("rejects wrong audience, expired tokens and missing email", async () => {
    const call = client(env());
    for (const t of [await sign({ email: "a@x.test" }, "other"), await sign({ email: "a@x.test" }, AUD, "-1m"), await sign({})])
      expect((await call("GET", "/v1/me", { headers: { "cf-access-jwt-assertion": t } })).status).toBe(401);
  });
  it("fails closed when Access is not configured in production", async () => {
    const call = client(makeEnv({ ENVIRONMENT: "production" }).env);
    expect((await call("GET", "/v1/me", { headers: { "cf-access-jwt-assertion": await sign({ email: "a@x.test" }) } })).status).toBe(401);
  });
});
