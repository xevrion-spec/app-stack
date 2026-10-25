import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-rbac@example.test",
  B = "owner-rbac-b@example.test",
  R1 = "reviewer-rbac@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function setup() {
  const h = makeEnv({ RATE_LIMIT_PER_MINUTE: "100000" });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "RBAC Co (synthetic)" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Other (synthetic)" } });
  const r1 = (await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } })).json.id as string;
  const prod = (await call("POST", "/v1/review-projects", { user: A, body: { name: "p", environment: "production" } })).json.id as string;
  const stg = (await call("POST", "/v1/review-projects", { user: A, body: { name: "s", environment: "staging" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"] } })).json.key as string;
  const create = async (projectId: string, risk = "medium") =>
    (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { projectId, action: "refund.issue", payload: { a: 1 }, risk } })).json.id as string;
  const role = (body: Record<string, unknown>) => call("POST", "/v1/roles", { user: A, body: { name: "r", permissions: [], ...body } });
  const assign = (userId: string, customRoleId: string | null) => call("PUT", `/v1/users/${userId}/custom-role`, { user: A, body: { customRoleId } });
  const decide = (id: string, decision: string, extra: Record<string, unknown> = {}) =>
    call("POST", `/v1/agent-reviews/${id}/decisions`, { user: R1, body: { decision, ...extra } });
  return { ...h, call, r1, prod, stg, create, role, assign, decide };
}

describe("custom roles: RBAC permissions + ABAC conditions (A8c)", () => {
  it("narrows visibility (list, get, wait, audit, evidence) and decisions by environment, permission and risk", async () => {
    const s = await setup();
    const [pMed, sMed, sHigh, sLow] = [await s.create(s.prod), await s.create(s.stg), await s.create(s.stg, "high"), await s.create(s.stg, "low")];
    const role = await s.role({ name: "Staging approver", permissions: ["reviews.approve", "reviews.escalate"], environments: ["staging"], maxRisk: "medium" });
    expect(role.status).toBe(201);
    expect((await s.assign(s.r1, role.json.id)).json).toEqual({ userId: s.r1, customRoleId: role.json.id });
    const ids = (await s.call("GET", "/v1/agent-reviews", { user: R1 })).json.items.map((x: { id: string }) => x.id).sort();
    expect(ids).toEqual([sMed, sHigh, sLow].sort());
    expect((await s.call("GET", `/v1/agent-reviews?projectId=${s.prod}`, { user: R1 })).json.items).toEqual([]);
    for (const path of [`/v1/agent-reviews/${pMed}`, `/v1/agent-reviews/${pMed}/wait?timeoutSeconds=0`, `/v1/agent-reviews/${pMed}/audit`])
      expect((await s.call("GET", path, { user: R1 })).status, path).toBe(404);
    expect((await s.decide(pMed, "approve")).status).toBe(404);
    const rej = await s.decide(sMed, "reject");
    expect([rej.status, rej.json.error.code]).toEqual([403, "forbidden_by_role"]);
    expect((await s.decide(sMed, "edit", { payload: { a: 2 } })).status).toBe(403);
    expect((await s.decide(sHigh, "approve")).json.error.code).toBe("forbidden_by_role");
    expect((await s.decide(sMed, "approve")).json.status).toBe("approved");
    expect((await s.decide(sLow, "escalate")).status).toBe(200);
    // role edits apply on the next request; unassigning restores the base role
    await s.call("PUT", `/v1/roles/${role.json.id}`, {
      user: A,
      body: { name: "Staging approver", permissions: ["reviews.approve", "reviews.reject"], environments: ["staging", "production"], maxRisk: null },
    });
    expect((await s.call("GET", `/v1/agent-reviews/${pMed}`, { user: R1 })).status).toBe(200);
    expect((await s.decide(sHigh, "reject")).json.status).toBe("rejected");
    await s.assign(s.r1, null);
    expect((await s.decide(pMed, "edit", { payload: { a: 3 } })).status).toBe(200);
    // owners and API keys are never narrowed
    expect((await s.call("GET", "/v1/agent-reviews", { user: A })).json.items).toHaveLength(4);
  });

  it("explicit project lists, empty permission sets, and an empty visible set (nothing leaks)", async () => {
    const s = await setup();
    const p = await s.create(s.prod);
    const none = await s.role({ name: "Read prod only", permissions: [], projects: [s.prod] });
    await s.assign(s.r1, none.json.id);
    expect((await s.call("GET", `/v1/agent-reviews/${p}`, { user: R1 })).status).toBe(200);
    for (const d of ["approve", "reject", "edit", "escalate"]) expect((await s.decide(p, d, d === "edit" ? { payload: {} } : {})).status, d).toBe(403);
    const nothing = await s.role({ name: "Staging prod only", permissions: ["reviews.approve"], projects: [s.prod], environments: ["staging"] });
    await s.assign(s.r1, nothing.json.id);
    expect((await s.call("GET", "/v1/agent-reviews", { user: R1 })).json.items).toEqual([]);
    expect((await s.call("GET", `/v1/agent-reviews/${p}`, { user: R1 })).status).toBe(404);
  });

  it("admin is owner-only, validated, audited, tenant-isolated; owners can't be narrowed; assigned roles can't be deleted", async () => {
    const s = await setup();
    expect((await s.call("POST", "/v1/roles", { user: R1, body: { name: "x", permissions: [] } })).status).toBe(403);
    expect((await s.role({ permissions: ["reviews.delete_everything"] })).status).toBe(400);
    expect((await s.role({ projects: ["nope"] })).status).toBe(404);
    const r = await s.role({ name: "dup" });
    expect((await s.role({ name: "dup" })).status).toBe(409);
    const ownerId = (s.raw.prepare("select id from users where email = ?").get(A) as { id: string }).id;
    expect((await s.assign(ownerId, r.json.id)).status).toBe(409);
    expect((await s.assign("nope", r.json.id)).status).toBe(404);
    expect((await s.assign(s.r1, "nope")).status).toBe(404);
    await s.assign(s.r1, r.json.id);
    expect((await s.call("GET", "/v1/roles", { user: A })).json.items[0]).toMatchObject({ name: "dup", assigned: 1 });
    expect((await s.call("DELETE", `/v1/roles/${r.json.id}`, { user: A })).status).toBe(409);
    expect((await s.call("GET", "/v1/roles", { user: B })).json.items).toEqual([]);
    expect((await s.call("PUT", `/v1/roles/${r.json.id}`, { user: B, body: { name: "x", permissions: [] } })).status).toBe(404);
    expect((await s.call("PUT", `/v1/users/${s.r1}/custom-role`, { user: B, body: { customRoleId: null } })).status).toBe(404);
    await s.assign(s.r1, null);
    expect((await s.call("DELETE", `/v1/roles/${r.json.id}`, { user: A })).json).toEqual({ deleted: true });
    const acts = (s.raw.prepare("select action from audit_log where action like 'role.%' order by created_at, rowid").all() as { action: string }[]).map(
      (a) => a.action,
    );
    expect(acts).toEqual(["role.created", "role.assigned", "role.unassigned", "role.deleted"]);
  });
});
