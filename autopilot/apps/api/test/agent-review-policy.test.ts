import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";
import { sweepAgentReviews } from "../src/services/agent-review.js";

const A = "owner-a@example.test",
  L = "lead@example.test",
  M = "manager@example.test",
  R1 = "reviewer-1@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

const POLICY = {
  rules: [
    { id: "block-big-wire", when: { action: "payment.wire", payload: [{ path: "amount", op: "gt", value: 10000 }] }, then: { outcome: "reject" } },
    {
      id: "small-refunds",
      when: { action: "refund.*", risk: ["low", "medium"], minConfidence: 0.9, payload: [{ path: "amount", op: "lte", value: 50 }] },
      then: { outcome: "auto_approve" },
    },
    {
      id: "vip",
      when: { payload: [{ path: "tier", op: "eq", value: "gold" }] },
      then: { outcome: "human", approvals: 1, group: "leads", escalateAfterSeconds: 600, escalateToGroup: "managers" },
    },
  ],
};

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Policy Co (synthetic)" } });
  for (const u of [L, M, R1]) await call("POST", "/v1/users", { user: A, body: { email: u, role: "reviewer" } });
  const projectId = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Payments agent" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId } })).json.key as string;
  const create = (body: Record<string, unknown>) =>
    call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "refund.issue", payload: { amount: 20 }, ...body } });
  const save = (document: unknown) => call("POST", `/v1/review-projects/${projectId}/policies`, { user: A, body: { document } });
  const activate = (v: number, body: Record<string, unknown> = {}) =>
    call("POST", `/v1/review-projects/${projectId}/policies/${v}/activate`, { user: A, body });
  return { ...h, call, projectId, key, create, save, activate };
}

describe("agent review policy engine API (A2)", () => {
  it("without a policy everything goes to one human (critical to two)", async () => {
    const s = await setup();
    expect((await s.create({ risk: "low", confidence: 0.99 })).json.routing).toMatchObject({ outcome: "human", policyVersion: 0, guardrails: [] });
    expect((await s.create({ risk: "critical" })).json).toMatchObject({ requiredApprovals: 2, routing: { guardrails: ["critical_four_eyes"] } });
  });

  it("versioned policy routes auto-approve, reject and groups; decisions and audit name the policy", async () => {
    const s = await setup();
    const p = await s.save(POLICY);
    expect([p.status, p.json.version, p.json.status]).toEqual([201, 1, "draft"]);
    expect((await s.activate(1)).json.policy.status).toBe("active");
    const auto = (await s.create({ risk: "low", confidence: 0.95 })).json;
    expect(auto).toMatchObject({ status: "approved", routing: { outcome: "auto_approve", ruleId: "small-refunds", policyVersion: 1 } });
    const got = (await s.call("GET", `/v1/agent-reviews/${auto.id}`, { user: A })).json;
    expect(got.decisions[0]).toMatchObject({ reviewer: "policy:v1:small-refunds", decision: "approve" });
    const lowConf = (await s.create({ risk: "low", confidence: 0.5 })).json;
    expect(lowConf).toMatchObject({ status: "pending", routing: { outcome: "human", ruleId: null } });
    const wire = (await s.create({ action: "payment.wire", payload: { amount: 50000 } })).json;
    expect(wire).toMatchObject({ status: "rejected", routing: { outcome: "reject", ruleId: "block-big-wire" } });
    const crit = (await s.create({ risk: "critical", confidence: 0.99 })).json;
    expect(crit).toMatchObject({ status: "pending", requiredApprovals: 2 });
    const events = (await s.call("GET", "/v1/events?limit=100", { user: A })).json.items.filter((e: { type: string }) => e.type === "review.completed");
    expect(events.map((e: { data: { status: string } }) => e.data.status).sort()).toEqual(["approved", "rejected"]);
  });

  it("refuses unsafe policies at save time", async () => {
    const s = await setup();
    const bad = await s.save({ rules: [{ id: "yolo", when: { risk: ["low", "critical"] }, then: { outcome: "auto_approve" } }] });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("minConfidence");
  });

  it("group routing, SLA escalation by the sweeper, escalation group decides", async () => {
    const s = await setup();
    await s.call("PUT", "/v1/review-groups/leads", { user: A, body: { members: [L.toUpperCase()] } });
    await s.call("PUT", "/v1/review-groups/managers", { user: A, body: { members: [M] } });
    expect((await s.call("GET", "/v1/review-groups", { user: R1 })).json.items).toEqual([
      { name: "leads", members: [L] },
      { name: "managers", members: [M] },
    ]);
    await s.save(POLICY);
    await s.activate(1);
    const r = (await s.create({ payload: { amount: 500, tier: "gold" } })).json;
    expect(r.routing).toMatchObject({ group: "leads", outcome: "human" });
    expect(r.routing.escalateAt).not.toBeNull();
    const outsider = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect([outsider.status, outsider.json.error.code]).toEqual([403, "not_in_group"]);
    expect((await s.call("GET", "/v1/agent-reviews?group=leads", { user: A })).json.items).toHaveLength(1);
    // SLA passes: the sweeper escalates to managers; leads can no longer decide
    await s.env.DB.prepare("update review_requests set escalate_at = '2000-01-01T00:00:00.000Z' where id = ?1").bind(r.id).run();
    expect(await sweepAgentReviews(s.env)).toEqual({ expired: 0, escalated: 1, conflicts: 0 });
    const esc = (await s.call("GET", `/v1/agent-reviews/${r.id}`, { user: A })).json;
    expect(esc).toMatchObject({ status: "escalated", routing: { group: "managers" } });
    expect(esc.decisions[0]).toMatchObject({ reviewer: "system:sla", decision: "escalate", reason: "SLA elapsed" });
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: L, body: { decision: "approve" } })).json.error.code).toBe("not_in_group");
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: M, body: { decision: "approve" } })).json.status).toBe("approved");
    // deadlines: the sweeper expires overdue requests
    const late = (await s.create({ payload: { amount: 999 } })).json;
    await s.env.DB.prepare("update review_requests set deadline_at = '2000-01-01T00:00:00.000Z' where id = ?1").bind(late.id).run();
    expect((await sweepAgentReviews(s.env)).expired).toBe(1);
    expect((await s.call("GET", `/v1/agent-reviews/${late.id}`, { user: A })).json.status).toBe("expired");
    // the owner can always decide routed requests
    const g2 = (await s.create({ payload: { amount: 600, tier: "gold" } })).json;
    expect((await s.call("POST", `/v1/agent-reviews/${g2.id}/decisions`, { user: A, body: { decision: "reject" } })).json.status).toBe("rejected");
  });

  it("time-travel replay diffs a candidate policy against history and gates unsafe activation", async () => {
    const s = await setup();
    // history under the default policy: humans approve small refunds, but reject one and edit one
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await s.create({ risk: "low", confidence: 0.95, payload: { amount: 10 + i } })).json.id);
    for (const id of ids.slice(0, 4)) await s.call("POST", `/v1/agent-reviews/${id}/decisions`, { user: R1, body: { decision: "approve" } });
    await s.call("POST", `/v1/agent-reviews/${ids[4]}/decisions`, { user: R1, body: { decision: "reject", reason: "fraud pattern" } });
    await s.call("POST", `/v1/agent-reviews/${ids[5]}/decisions`, { user: R1, body: { decision: "edit", payload: { amount: 1 } } });
    const rep = (await s.call("POST", `/v1/review-projects/${s.projectId}/policies/replay`, { user: A, body: { document: POLICY } })).json;
    expect(rep).toMatchObject({
      evaluated: 6,
      changed: 6,
      reviewsSaved: 4,
      wouldAutoApproveRejected: 1,
      wouldAutoApproveEdited: 1,
      humanLoadDelta: -6,
      safe: false,
    });
    expect(rep.transitions).toEqual({ "human->auto_approve": 6 });
    expect(rep.samples.slice(0, 2).map((x: { flag: string }) => x.flag)).toEqual(["risky_auto_approve", "risky_auto_approve"]);
    // activation is refused unless forced, and the forced activation is audited
    await s.save(POLICY);
    const refused = await s.activate(1);
    expect([refused.status, refused.json.error.code]).toEqual([409, "unsafe_policy"]);
    const forced = await s.activate(1, { force: true });
    expect([forced.status, forced.json.policy.status, forced.json.replay.safe]).toEqual([200, "active", false]);
    const audit = await s.env.DB.prepare("select meta_json from audit_log where action = 'review_policy.activated'").first<{ meta_json: string }>();
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ forced: true, version: 1 });
    // a stricter policy replays as safe, and replay by saved version works
    const strict = { rules: [{ id: "small-refunds", when: { action: "refund.*", risk: ["low"], minConfidence: 0.99 }, then: { outcome: "auto_approve" } }] };
    await s.save(strict);
    const byVersion = (await s.call("POST", `/v1/review-projects/${s.projectId}/policies/replay`, { user: A, body: { version: 2 } })).json;
    expect([byVersion.safe, byVersion.changed]).toEqual([true, 0]);
    expect((await s.call("POST", `/v1/review-projects/${s.projectId}/policies/replay`, { user: A, body: {} })).status).toBe(400);
    expect((await s.call("POST", `/v1/review-projects/${s.projectId}/policies/replay`, { user: A, body: { version: 99 } })).status).toBe(404);
  });

  it("canary arm takes a stable share of traffic; full activation retires old versions", async () => {
    const s = await setup();
    await s.save({ rules: [] }); // v1: everything human
    await s.activate(1);
    await s.save({ rules: [{ id: "all-low", when: { risk: ["low"], minConfidence: 0.5 }, then: { outcome: "auto_approve" } }] }); // v2
    const c = await s.activate(2, { canaryPercent: 30 });
    expect(c.json.policy).toMatchObject({ status: "canary", canaryPercent: 30 });
    const versions: number[] = [];
    for (let i = 0; i < 60; i++) versions.push((await s.create({ risk: "low", confidence: 0.9, payload: { amount: 1000 + i } })).json.routing.policyVersion);
    const share = versions.filter((v) => v === 2).length / versions.length;
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.55);
    await s.activate(2, { force: true });
    const list = (await s.call("GET", `/v1/review-projects/${s.projectId}/policies`, { user: A })).json.items;
    expect(list.map((p: { version: number; status: string }) => `${p.version}:${p.status}`)).toEqual(["2:active", "1:retired"]);
    expect((await s.create({ risk: "low", confidence: 0.9 })).json.routing.policyVersion).toBe(2);
  });

  it("simulate is a dry run against the live policy or a draft; permissions", async () => {
    const s = await setup();
    await s.save(POLICY);
    await s.activate(1);
    const sim = await s.call("POST", "/v1/agent-reviews/simulate", {
      headers: bearer(s.key),
      body: { request: { action: "refund.issue", risk: "low", confidence: 0.95, payload: { amount: 5 } } },
    });
    expect(sim.json).toMatchObject({ outcome: "auto_approve", ruleId: "small-refunds", policyVersion: 1 });
    expect(sim.json.trace.map((t: { matched: boolean }) => t.matched)).toEqual([false, true]);
    const draft = await s.call("POST", "/v1/agent-reviews/simulate", {
      user: A,
      body: { request: { projectId: s.projectId, action: "x", payload: {} }, document: { rules: [], default: { outcome: "reject" } } },
    });
    expect(draft.json).toMatchObject({ outcome: "reject", policyVersion: -1 });
    expect((await s.call("GET", "/v1/agent-reviews", { user: A })).json.items).toHaveLength(0);
    // reviewers cannot write policies or groups; API keys cannot activate
    expect((await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: R1, body: { document: POLICY } })).status).toBe(403);
    expect((await s.call("PUT", "/v1/review-groups/leads", { user: R1, body: { members: [] } })).status).toBe(403);
    expect((await s.call("POST", `/v1/review-projects/${s.projectId}/policies/1/activate`, { headers: bearer(s.key), body: {} })).status).toBe(403);
    expect((await s.call("GET", `/v1/review-projects/${s.projectId}/policies`, { headers: bearer(s.key) })).status).toBe(200);
  });
});
