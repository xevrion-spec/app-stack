import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const OWNER = "owner-scim@corp.example.test",
  BOB = "bob@corp.example.test";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: OWNER, body: { name: "Corp (synthetic)" } });
  await call("POST", "/v1/tenants", { user: "other@example.test", body: { name: "Other (synthetic)" } });
  const scimKey = (await call("POST", "/v1/api-keys", { user: OWNER, body: { name: "okta", scopes: ["scim:write"] } })).json.key as string;
  const readKey = (await call("POST", "/v1/api-keys", { user: OWNER, body: { name: "r", scopes: ["reviews:read"] } })).json.key as string;
  const sc = (method: string, path: string, body?: unknown, key = scimKey) =>
    call(method, `/v1/scim/v2${path}`, { headers: { authorization: `Bearer ${key}` }, ...(body !== undefined ? { body } : {}) });
  return { ...h, call, sc, scimKey, readKey };
}

describe("SCIM 2.0 Users (A8b)", () => {
  it("provisions, filters, updates role, deactivates (blocking login), reactivates and tombstones", async () => {
    const s = await setup();
    const made = await s.sc("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "Bob@corp.example.test",
      externalId: "okta-1",
      name: { givenName: "Bob", familyName: "Synthetic" },
      roles: [{ value: "reviewer" }],
    });
    expect(made.status).toBe(201);
    expect(made.headers.get("content-type")).toContain("application/scim+json");
    expect(made.json).toMatchObject({ userName: BOB, externalId: "okta-1", displayName: "Bob Synthetic", active: true, roles: [{ value: "reviewer" }] });
    const id = made.json.id as string;
    expect((await s.sc("POST", "/Users", { userName: BOB })).json).toMatchObject({ status: "409", scimType: "uniqueness" });
    const byName = (await s.sc("GET", `/Users?filter=${encodeURIComponent('userName eq "BOB@corp.example.test"')}`)).json;
    expect([byName.totalResults, byName.Resources[0].id]).toEqual([1, id]);
    expect((await s.sc("GET", `/Users?filter=${encodeURIComponent('externalId eq "okta-1"')}`)).json.totalResults).toBe(1);
    expect((await s.sc("GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@x.test"')}`)).json).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await s.sc("GET", `/Users?filter=${encodeURIComponent('displayName co "x"')}`)).json.scimType).toBe("invalidFilter");
    expect((await s.call("GET", "/v1/me", { user: BOB })).json.role).toBe("reviewer");
    const up = await s.sc("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "roles", value: [{ value: "accountant" }] }] });
    expect(up.json.roles).toEqual([{ value: "accountant", primary: true }]);
    expect((await s.call("GET", "/v1/me", { user: BOB })).json.role).toBe("accountant");
    // Okta-style deactivate: value object form
    const off = await s.sc("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "Replace", value: { active: false } }] });
    expect(off.json.active).toBe(false);
    expect((await s.call("GET", "/v1/me", { user: BOB })).status).toBe(403);
    const on = await s.sc("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] });
    expect(on.json.active).toBe(true);
    expect((await s.call("GET", "/v1/me", { user: BOB })).status).toBe(200);
    expect((await s.sc("DELETE", `/Users/${id}`)).status).toBe(204);
    expect((await s.sc("GET", `/Users/${id}`)).json.active).toBe(false);
    expect((await s.call("GET", "/v1/me", { user: BOB })).status).toBe(403);
    const acts = (
      s.raw.prepare("select action from audit_log where subject = ? and action like 'user.%' order by created_at, rowid").all(id) as { action: string }[]
    ).map((a) => a.action);
    expect(acts).toEqual(["user.provisioned", "user.updated", "user.deactivated", "user.reactivated", "user.deactivated"]);
  });

  it("never creates, changes or deactivates owners; validates input; needs the scim:write scope; is tenant-isolated", async () => {
    const s = await setup();
    const owner = (await s.sc("GET", `/Users?filter=${encodeURIComponent(`userName eq "${OWNER}"`)}`)).json.Resources[0];
    expect(owner.roles[0].value).toBe("owner");
    expect((await s.sc("PATCH", `/Users/${owner.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] })).status).toBe(403);
    expect((await s.sc("DELETE", `/Users/${owner.id}`)).status).toBe(403);
    expect((await s.sc("PUT", `/Users/${owner.id}`, { userName: OWNER, roles: [{ value: "reviewer" }] })).status).toBe(403);
    expect((await s.sc("POST", "/Users", { userName: "x@corp.example.test", roles: [{ value: "owner" }] })).json.scimType).toBe("invalidValue");
    expect((await s.sc("POST", "/Users", { userName: "not-an-email" })).status).toBe(400);
    const u = (await s.sc("POST", "/Users", { userName: "c@corp.example.test" })).json;
    expect((await s.sc("PUT", `/Users/${u.id}`, { userName: "renamed@corp.example.test" })).json.scimType).toBe("mutability");
    expect((await s.sc("PATCH", `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: "remove", path: "active" }] })).status).toBe(400);
    expect((await s.sc("PATCH", `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "emails", value: [] }] })).json.scimType).toBe(
      "invalidPath",
    );
    expect((await s.sc("PATCH", `/Users/${u.id}`, { Operations: [{ op: "replace", path: "active", value: false }] })).status).toBe(400);
    expect((await s.sc("GET", "/Users", undefined, s.readKey)).status).toBe(403);
    expect((await s.call("GET", "/v1/scim/v2/Users", { user: BOB })).status).toBeGreaterThanOrEqual(400);
    expect((await s.call("GET", "/v1/scim/v2/Users")).status).toBe(401);
    const otherKey = (await s.call("POST", "/v1/api-keys", { user: "other@example.test", body: { name: "o", scopes: ["scim:write"] } })).json.key as string;
    expect((await s.sc("GET", `/Users/${u.id}`, undefined, otherKey)).status).toBe(404);
    expect((await s.sc("GET", "/Users", undefined, otherKey)).json.totalResults).toBe(1);
    // pagination
    for (let i = 0; i < 4; i++) await s.sc("POST", "/Users", { userName: `p${i}@corp.example.test` });
    const page = (await s.sc("GET", "/Users?startIndex=2&count=3")).json;
    expect([page.totalResults, page.itemsPerPage, page.startIndex]).toEqual([6, 3, 2]);
    expect((await s.sc("GET", "/ServiceProviderConfig")).json.patch.supported).toBe(true);
  });
});
