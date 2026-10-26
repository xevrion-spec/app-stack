import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R1 = "reviewer-1@example.test",
  R2 = "reviewer-2@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Agent Co (synthetic)" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Other Co (synthetic)" } });
  for (const r of [R1, R2]) await call("POST", "/v1/users", { user: A, body: { email: r, role: "reviewer" } });
  const p = await call("POST", "/v1/review-projects", { user: A, body: { name: "Support agent", environment: "production" } });
  expect(p.status).toBe(201);
  const key = async (scopes: string[], projectId?: string) =>
    (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes, ...(projectId ? { projectId } : {}) } })).json as { id: string; key: string };
  const agent = await key(["reviews:write"], p.json.id);
  const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call("POST", "/v1/agent-reviews", {
      body: { action: "refund.issue", payload: { orderId: "SYN-1", amount: 120 }, ...body },
      headers: { ...bearer(agent.key), ...headers },
    });
  return { ...h, call, projectId: p.json.id as string, agent, key, create };
}

describe("agent review API (A1)", () => {
  it("full single-approver journey with events and audit", async () => {
    const s = await setup();
    const r = await s.create({ risk: "medium", context: { reason: "customer asked" }, externalId: "run-42", tags: ["refunds"] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "pending", requiredApprovals: 1, approvals: 0, externalId: "run-42", payloadVersion: 1 });
    expect(r.json.requester).toMatch(/^api_key:/);
    const d = await s.call("POST", `/v1/agent-reviews/${r.json.id}/decisions`, { user: R1, body: { decision: "approve", reason: "looks fine" } });
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ status: "approved", approvals: 1 });
    const got = await s.call("GET", `/v1/agent-reviews/${r.json.id}`, { headers: bearer(s.agent.key) });
    expect(got.json.decisions).toHaveLength(1);
    expect(got.json.decisions[0]).toMatchObject({ reviewer: R1, decision: "approve", reason: "looks fine" });
    const again = await s.call("POST", `/v1/agent-reviews/${r.json.id}/decisions`, { user: R2, body: { decision: "reject" } });
    expect([again.status, again.json.error?.code]).toEqual([409, "already_final"]);
    const types = (await s.call("GET", "/v1/events?limit=50", { user: A })).json.items?.map((e: { type: string }) => e.type) ?? [];
    expect(types).toEqual(expect.arrayContaining(["review.requested", "review.decision_recorded", "review.completed"]));
    const audit = await s.env.DB.prepare("select action from audit_log where subject = ?1 order by created_at").bind(r.json.id).all<{ action: string }>();
    expect(audit.results.map((x) => x.action)).toEqual(["review.requested", "review.approve"]);
  });

  it("critical risk requires four-eyes; an edit resets approvals to the new payload", async () => {
    const s = await setup();
    const r = (await s.create({ risk: "critical" })).json;
    expect(r.requiredApprovals).toBe(2);
    let d = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect(d.json).toMatchObject({ status: "pending", approvals: 1 });
    const dup = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect([dup.status, dup.json.error?.code]).toEqual([409, "duplicate_decision"]);
    d = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R2, body: { decision: "edit", payload: { orderId: "SYN-1", amount: 60 } } });
    expect(d.json).toMatchObject({ status: "pending", approvals: 1, payloadVersion: 2, payload: { amount: 60 }, originalPayload: { amount: 120 } });
    expect(d.json.payloadDiff).toEqual({ changes: [{ path: "amount", op: "change", from: 120, to: 60 }], truncated: false });
    d = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect(d.json).toMatchObject({ status: "approved", approvals: 2, payload: { amount: 60 } });
    const completed = (await s.call("GET", "/v1/events?limit=50", { user: A })).json.items.find((e: { type: string }) => e.type === "review.completed");
    expect(completed.data).toMatchObject({ status: "approved", payload: { amount: 60 }, payloadVersion: 2 });
  });

  it("idempotency: same key + body returns the original; different body is 409; minApprovals only raises", async () => {
    const s = await setup();
    const a = await s.create({ minApprovals: 3 }, { "idempotency-key": "run-1-step-3" });
    const b = await s.create({ minApprovals: 3 }, { "idempotency-key": "run-1-step-3" });
    expect(a.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect(a.json.requiredApprovals).toBe(3);
    const c = await s.create({ minApprovals: 3, payload: { orderId: "SYN-2", amount: 1 } }, { "idempotency-key": "run-1-step-3" });
    expect(c.status).toBe(409);
    const list = (await s.call("GET", "/v1/agent-reviews", { headers: bearer(s.agent.key) })).json;
    expect(list.items).toHaveLength(1);
  });

  it("requester cannot approve its own request, only cancel it; reviewers cannot cancel", async () => {
    const s = await setup();
    const own = (
      await s.call("POST", "/v1/agent-reviews", { user: A, body: { projectId: s.projectId, action: "email.send", payload: { to: "x@example.test" } } })
    ).json;
    const self = await s.call("POST", `/v1/agent-reviews/${own.id}/decisions`, { user: A, body: { decision: "approve" } });
    expect([self.status, self.json.error?.code]).toEqual([403, "self_approval"]);
    const notMine = await s.call("POST", `/v1/agent-reviews/${own.id}/cancel`, { user: R1 });
    expect([notMine.status, notMine.json.error?.code]).toEqual([403, "not_requester"]);
    expect((await s.call("POST", `/v1/agent-reviews/${own.id}/cancel`, { user: A })).json.status).toBe("cancelled");
  });

  it("escalate then approve; reject is a veto; validation errors", async () => {
    const s = await setup();
    const r = (await s.create({ risk: "high" })).json;
    expect(
      (await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "escalate", reason: "needs a lead" } })).json.status,
    ).toBe("escalated");
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R2, body: { decision: "approve" } })).json.status).toBe("approved");
    const v = (await s.create({ risk: "critical" })).json;
    await s.call("POST", `/v1/agent-reviews/${v.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect((await s.call("POST", `/v1/agent-reviews/${v.id}/decisions`, { user: R2, body: { decision: "reject" } })).json.status).toBe("rejected");
    expect((await s.call("POST", `/v1/agent-reviews/${v.id}/decisions`, { user: R2, body: { decision: "edit" } })).status).toBe(400);
    expect((await s.create({ action: "Bad Action" })).status).toBe(400);
    expect((await s.create({ deadlineAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
  });

  it("deadlines expire lazily and expired requests refuse decisions", async () => {
    const s = await setup();
    const r = (await s.create({ timeoutSeconds: 10 })).json;
    await s.env.DB.prepare("update review_requests set deadline_at = '2000-01-01T00:00:00.000Z' where id = ?1").bind(r.id).run();
    const got = await s.call("GET", `/v1/agent-reviews/${r.id}`, { user: R1 });
    expect(got.json.status).toBe("expired");
    const d = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect([d.status, d.json.error?.code]).toEqual([409, "already_final"]);
  });

  it("scopes, project binding, revoked keys and tenant isolation", async () => {
    const s = await setup();
    const r = (await s.create({})).json;
    // the agent key can create but not decide
    const noDecide = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { headers: bearer(s.agent.key), body: { decision: "approve" } });
    expect([noDecide.status, noDecide.json.error?.code]).toEqual([403, "insufficient_scope"]);
    // keys cannot create projects
    expect((await s.call("POST", "/v1/review-projects", { headers: bearer(s.agent.key), body: { name: "x" } })).status).toBe(403);
    // a key bound to project 2 cannot see project 1's requests
    const p2 = (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "Other agent", environment: "staging" } })).json;
    const k2 = await s.key(["reviews:write"], p2.id);
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: bearer(k2.key) })).status).toBe(404);
    expect((await s.call("GET", "/v1/agent-reviews", { headers: bearer(k2.key) })).json.items).toHaveLength(0);
    expect((await s.call("POST", "/v1/agent-reviews", { headers: bearer(k2.key), body: { projectId: s.projectId, action: "a", payload: {} } })).status).toBe(
      403,
    );
    expect((await s.call("GET", `/v1/agent-reviews?projectId=${s.projectId}`, { headers: bearer(k2.key) })).status).toBe(403);
    expect((await s.call("GET", "/v1/review-projects", { headers: bearer(k2.key) })).json.items.map((p: { id: string }) => p.id)).toEqual([p2.id]);
    // a tenant-wide key with decide scope can decide (programmatic reviewer) but must name a project to create
    const wide = await s.key(["reviews:write", "reviews:decide"]);
    expect((await s.call("POST", "/v1/agent-reviews", { headers: bearer(wide.key), body: { action: "a", payload: {} } })).status).toBe(400);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { headers: bearer(wide.key), body: { decision: "approve" } })).json.status).toBe(
      "approved",
    );
    // other tenant sees nothing; unknown project 404; duplicate project 409
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}`, { user: B })).status).toBe(404);
    expect((await s.call("POST", "/v1/agent-reviews", { user: A, body: { projectId: "nope", action: "a", payload: {} } })).status).toBe(404);
    expect((await s.call("POST", "/v1/review-projects", { user: A, body: { name: "Support agent", environment: "production" } })).status).toBe(409);
    expect((await s.call("POST", "/v1/api-keys", { user: A, body: { name: "x", scopes: ["reviews:read"], projectId: "nope" } })).status).toBe(404);
    // reviewers cannot create projects; revoked keys stop working; rotation keeps the binding
    expect((await s.call("POST", "/v1/review-projects", { user: R1, body: { name: "y" } })).status).toBe(403);
    const rot = (await s.call("POST", `/v1/api-keys/${k2.id}/rotate`, { user: A })).json;
    expect(rot.project_id).toBe(p2.id);
    await s.call("DELETE", `/v1/api-keys/${s.agent.id}`, { user: A });
    expect((await s.create({})).status).toBe(401);
  });

  it("lists with filters and cursor pagination", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await s.create({ externalId: `run-${i}`, risk: i % 2 ? "high" : "low" });
    const p1 = (await s.call("GET", "/v1/agent-reviews?limit=2", { user: R1 })).json;
    expect(p1.items).toHaveLength(2);
    const p2 = (await s.call("GET", `/v1/agent-reviews?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, { user: R1 })).json;
    expect(p2.items.map((x: { id: string }) => x.id)).not.toContain(p1.items[0].id);
    expect((await s.call("GET", "/v1/agent-reviews?risk=high", { user: R1 })).json.items).toHaveLength(2);
    expect((await s.call("GET", "/v1/agent-reviews?externalId=run-3", { user: R1 })).json.items).toHaveLength(1);
    expect((await s.call("GET", `/v1/agent-reviews?status=pending&projectId=${s.projectId}`, { user: R1 })).json.items).toHaveLength(5);
  });
});
