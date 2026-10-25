import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-sec@example.test",
  B = "owner-sec-b@example.test",
  M = "member-sec@example.test";
async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Sec Co (synthetic)" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Other Sec (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: M, role: "member" } });
  const mk = async (body: Record<string, unknown>) => call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["transactions:read"], ...body } });
  const use = (key: string, ip?: string) =>
    call("GET", "/v1/transactions", { headers: { authorization: `Bearer ${key}`, ...(ip ? { "cf-connecting-ip": ip } : {}) } });
  return { ...h, call, mk, use };
}

describe("API key IP allowlists + key policy (A9a)", () => {
  it("allowlisted key works only from listed networks and fails closed without a client IP", async () => {
    const s = await setup();
    const k = await s.mk({ allowedCidrs: ["203.0.113.0/24", "2001:db8::/32"] });
    expect(k.status).toBe(201);
    expect(k.json.allowed_cidrs).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    expect((await s.use(k.json.key, "203.0.113.50")).status).toBe(200);
    expect((await s.use(k.json.key, "2001:db8:1::9")).status).toBe(200);
    expect((await s.use(k.json.key, "::ffff:203.0.113.51")).status).toBe(200);
    const denied = await s.use(k.json.key, "198.51.100.1");
    expect([denied.status, denied.json.error.code]).toEqual([403, "ip_not_allowed"]);
    expect((await s.use(k.json.key)).status).toBe(403);
    expect((await s.use(k.json.key, "garbage")).status).toBe(403);
    // a denied attempt does not count as use
    const fresh = await s.mk({ allowedCidrs: ["203.0.113.0/24"] });
    expect((await s.use(fresh.json.key, "198.51.100.1")).status).toBe(403);
    const listed = (await s.call("GET", "/v1/api-keys", { user: A })).json as { id: string; last_used_at: string | null }[];
    expect(listed.find((x) => x.id === fresh.json.id)!.last_used_at).toBeNull();
    // keys without an allowlist keep working from anywhere
    const open = await s.mk({});
    expect(open.json.allowed_cidrs).toBeNull();
    expect((await s.use(open.json.key)).status).toBe(200);
  });

  it("rejects malformed CIDRs with zero rows written and keeps the allowlist on rotation", async () => {
    const s = await setup();
    for (const bad of [["10.0.0.0/33"], ["nope"], [], Array(51).fill("10.0.0.1")]) expect((await s.mk({ allowedCidrs: bad })).status).toBe(400);
    expect(s.raw.prepare("select count(*) n from api_keys").get()).toEqual({ n: 0 });
    const k = await s.mk({ allowedCidrs: ["10.0.0.0/8"] });
    const rot = await s.call("POST", `/v1/api-keys/${k.json.id}/rotate`, { user: A });
    expect(rot.json.allowed_cidrs).toEqual(["10.0.0.0/8"]);
    expect((await s.use(rot.json.key, "10.9.9.9")).status).toBe(200);
    expect((await s.use(rot.json.key, "11.0.0.1")).status).toBe(403);
  });

  it("tenant key policy caps lifetime, can require allowlists, is owner-only, audited and tenant-scoped", async () => {
    const s = await setup();
    expect((await s.call("GET", "/v1/security/key-policy", { user: A })).json).toEqual({ maxExpiryDays: null, requireIpAllowlist: false });
    expect((await s.call("PUT", "/v1/security/key-policy", { user: M, body: { maxExpiryDays: 30, requireIpAllowlist: true } })).status).toBe(403);
    expect((await s.call("PUT", "/v1/security/key-policy", { user: A, body: { maxExpiryDays: 0, requireIpAllowlist: true } })).status).toBe(400);
    const put = await s.call("PUT", "/v1/security/key-policy", { user: A, body: { maxExpiryDays: 30, requireIpAllowlist: true } });
    expect(put.status).toBe(200);
    const noList = await s.mk({});
    expect([noList.status, noList.json.error.code]).toEqual([422, "policy_violation"]);
    expect((await s.mk({ allowedCidrs: ["10.0.0.0/8"], expiresInDays: 90 })).status).toBe(422);
    const capped = await s.mk({ allowedCidrs: ["10.0.0.0/8"] });
    expect(capped.status).toBe(201);
    const days = (Date.parse(capped.json.expires_at) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect((await s.mk({ allowedCidrs: ["10.0.0.0/8"], expiresInDays: 7 })).status).toBe(201);
    // other tenant unaffected
    expect((await s.call("GET", "/v1/security/key-policy", { user: B })).json.requireIpAllowlist).toBe(false);
    expect((await s.call("POST", "/v1/api-keys", { user: B, body: { name: "b", scopes: ["transactions:read"] } })).status).toBe(201);
    const audit = s.raw.prepare("select action from audit_log where action = 'security.key_policy.updated'").all();
    expect(audit).toHaveLength(1);
    // keys cannot change policy (they cannot reach owner routes at all)
    const kk = await s.mk({ allowedCidrs: ["10.0.0.0/8"] });
    expect(
      (
        await s.call("PUT", "/v1/security/key-policy", {
          headers: { authorization: `Bearer ${kk.json.key}`, "cf-connecting-ip": "10.0.0.1" },
          body: { maxExpiryDays: null, requireIpAllowlist: false },
        })
      ).status,
    ).toBe(403);
  });
});
