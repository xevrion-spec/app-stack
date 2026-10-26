import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-a@example.test",
  L1 = "lead-1@example.test",
  L2 = "lead-2@example.test",
  F1 = "fin-1@example.test",
  F2 = "fin-2@example.test",
  F3 = "fin-3@example.test",
  OUT = "outsider@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

const CHAIN = {
  rules: [
    {
      id: "refund-chain",
      when: { action: "refund.*" },
      then: {
        outcome: "human",
        steps: [
          { name: "lead", group: "leads", approvals: 1 },
          { name: "finance", group: "finance", quorumPercent: 60 },
        ],
      },
    },
    { id: "biz", when: { action: "email.*" }, then: { outcome: "human", timeoutSeconds: 3600, escalateAfterSeconds: 1800, clock: "business" } },
  ],
};

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Workflow Co (synthetic)" } });
  for (const u of [L1, L2, F1, F2, F3, OUT]) await call("POST", "/v1/users", { user: A, body: { email: u, role: "reviewer" } });
  const projectId = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Refunds agent" } })).json.id as string;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId } })).json.key as string;
  await call("PUT", "/v1/review-groups/leads", { user: A, body: { members: [L1, L2] } });
  await call("PUT", "/v1/review-groups/finance", { user: A, body: { members: [F1, F2, F3] } });
  const saved = await call("POST", `/v1/review-projects/${projectId}/policies`, { user: A, body: { document: CHAIN } });
  expect(saved.status).toBe(201);
  await call("POST", `/v1/review-projects/${projectId}/policies/${saved.json.version}/activate`, { user: A, body: {} });
  const create = async (body: Record<string, unknown> = {}) =>
    (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "refund.issue", payload: { amount: 120 }, ...body } })).json;
  const decide = (id: string, user: string, decision = "approve", extra: Record<string, unknown> = {}) =>
    call("POST", `/v1/agent-reviews/${id}/decisions`, { user, body: { decision, ...extra } });
  return { ...h, call, projectId, key, create, decide };
}

describe("R3 approval chains, quorum, delegation, business hours", () => {
  it("chain: lead then a 60% finance quorum (2 of 3), each step gated to its group, progress reported", async () => {
    const s = await setup();
    const r = await s.create();
    expect(r.requiredApprovals).toBe(3);
    expect(r.routing.group).toBe("leads");
    expect(r.routing.chain).toEqual({
      currentStep: 0,
      steps: [
        { name: "lead", group: "leads", required: 1, approvals: 0, state: "current" },
        { name: "finance", group: "finance", required: 2, approvals: 0, state: "waiting" },
      ],
    });
    expect((await s.decide(r.id, F1)).json.error.code).toBe("not_in_group");
    const a1 = (await s.decide(r.id, L1)).json;
    expect([a1.status, a1.routing.group, a1.routing.chain.currentStep]).toEqual(["pending", "finance", 1]);
    expect((await s.decide(r.id, L2)).json.error.code).toBe("not_in_group");
    expect((await s.decide(r.id, F1)).json.routing.chain.steps[1].approvals).toBe(1);
    expect((await s.decide(r.id, F1)).status).toBe(409);
    const done = (await s.decide(r.id, F2)).json;
    expect([done.status, done.routing.chain.currentStep, done.approvals]).toEqual(["approved", null, 3]);
    expect(done.routing.chain.steps.map((x: { state: string }) => x.state)).toEqual(["done", "done"]);
  });

  it("quorum counts only active reviewers; an empty group is flagged; edits restart the chain", async () => {
    const s = await setup();
    const f3 = (s.raw.prepare("select id from users where email = ?").get(F3) as { id: string }).id;
    s.raw.prepare("update users set deactivated_at = datetime('now') where id = ?").run(f3);
    const r = await s.create();
    expect(r.routing.chain.steps[1].required).toBe(2); // ceil(60% of 2) = 2
    await s.call("PUT", "/v1/review-groups/finance", { user: A, body: { members: [] } });
    const empty = await s.create({ externalId: "e2" });
    expect(empty.routing.guardrails).toContain("quorum_empty_group:finance");
    const a = (await s.decide(r.id, L1)).json;
    expect(a.routing.chain.currentStep).toBe(1);
    const edited = (await s.decide(r.id, A, "edit", { payload: { amount: 100 } })).json;
    expect([edited.status, edited.payloadVersion, edited.routing.chain.currentStep, edited.routing.group]).toEqual(["pending", 2, 0, "leads"]);
  });

  it("critical chains keep four-eyes", async () => {
    const s = await setup();
    await s.call("PUT", "/v1/review-groups/finance", { user: A, body: { members: [F1] } });
    const doc = { rules: [{ id: "one", when: {}, then: { outcome: "human", steps: [{ name: "only", group: "finance", approvals: 1 }] } }] };
    const v = (await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } })).json.version;
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${v}/activate`, { user: A, body: {} });
    const r = await s.create({ risk: "critical" });
    expect([r.requiredApprovals, r.routing.guardrails]).toEqual([2, ["critical_four_eyes"]]);
  });

  it("delegation: time-boxed, one hop, audited, revocable; validation and visibility", async () => {
    const s = await setup();
    const r = await s.create();
    expect((await s.decide(r.id, OUT)).json.error.code).toBe("not_in_group");
    const ends = new Date(Date.now() + 86_400_000).toISOString();
    const bad = (body: Record<string, unknown>, user = L1) => s.call("POST", "/v1/review-delegations", { user, body });
    expect((await bad({ toEmail: L1, endsAt: ends })).status).toBe(400);
    expect((await bad({ toEmail: "nobody@example.test", endsAt: ends })).status).toBe(400);
    expect((await bad({ toEmail: OUT, endsAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await bad({ toEmail: OUT, endsAt: new Date(Date.now() + 91 * 86_400_000).toISOString() })).status).toBe(400);
    expect((await bad({ toEmail: OUT, fromEmail: L2, endsAt: ends })).status).toBe(403);
    expect((await s.call("POST", "/v1/review-delegations", { headers: bearer(s.key), body: { toEmail: OUT, endsAt: ends } })).status).toBe(403);
    const future = (await bad({ toEmail: OUT, startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: ends })).json;
    expect(future.active).toBe(false);
    expect((await s.decide(r.id, OUT)).json.error.code).toBe("not_in_group");
    const d = await bad({ toEmail: OUT, endsAt: ends, reason: "Annual leave" });
    expect(d.status).toBe(201);
    expect(d.json).toMatchObject({ fromEmail: L1, toEmail: OUT, active: true, reason: "Annual leave" });
    const list = (await s.call("GET", "/v1/review-delegations", { user: L1 })).json.items;
    expect(list.map((x: { id: string; revokedAt: string | null }) => [x.id === d.json.id, !!x.revokedAt])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect((await s.call("GET", "/v1/review-delegations", { user: F1 })).json.items).toEqual([]);
    expect((await s.call("GET", "/v1/review-delegations", { user: A })).json.items).toHaveLength(2);
    // one hop: OUT cannot pass L1's duties on to F1 (F1 is not a delegate of a lead)
    await s.call("POST", "/v1/review-delegations", { user: OUT, body: { toEmail: F1, endsAt: ends } });
    const viaDelegate = (await s.decide(r.id, OUT)).json;
    expect([viaDelegate.status, viaDelegate.routing.chain.currentStep]).toEqual(["pending", 1]);
    const audit = s.raw.prepare("select actor, meta_json from audit_log where action = 'review.delegated_decision'").all() as {
      actor: string;
      meta_json: string;
    }[];
    expect(audit.map((x) => [x.actor, JSON.parse(x.meta_json).onBehalfOf])).toEqual([[OUT, L1]]);
    // revoke: only the delegator or an owner
    expect((await s.call("DELETE", `/v1/review-delegations/${d.json.id}`, { user: F1 })).status).toBe(404);
    const rev = (await s.call("DELETE", `/v1/review-delegations/${d.json.id}`, { user: L1 })).json;
    expect([rev.active, !!rev.revokedAt]).toEqual([false, true]);
    expect((await s.call("DELETE", `/v1/review-delegations/${d.json.id}`, { user: A })).json.revokedAt).toBe(rev.revokedAt);
    const r2 = await s.create({ externalId: "r2" });
    expect((await s.decide(r2.id, OUT)).json.error.code).toBe("not_in_group");
    // owners may delegate for a reviewer; a deactivated delegator's delegation stops working
    const forL2 = await s.call("POST", "/v1/review-delegations", { user: A, body: { fromEmail: L2, toEmail: OUT, endsAt: ends } });
    expect(forL2.json.createdBy).toBe(A);
    const l2 = (s.raw.prepare("select id from users where email = ?").get(L2) as { id: string }).id;
    s.raw.prepare("update users set deactivated_at = datetime('now') where id = ?").run(l2);
    expect((await s.decide(r2.id, OUT)).json.error.code).toBe("not_in_group");
  });

  it("business hours: calendar CRUD with validation; business-clock deadlines skip nights and weekends", async () => {
    const s = await setup();
    const path = `/v1/review-projects/${s.projectId}/business-hours`;
    expect((await s.call("GET", path, { user: L1 })).json).toEqual({ businessHours: null });
    const noCal = await s.create({ action: "email.send" });
    expect(noCal.routing.guardrails).toContain("business_clock_without_calendar");
    expect(
      (await s.call("PUT", path, { user: A, body: { businessHours: { timeZone: "Nowhere/Zone", days: [1], start: "09:00", end: "17:00" } } })).status,
    ).toBe(400);
    expect((await s.call("PUT", path, { user: L1, body: { businessHours: null } })).status).toBe(403);
    expect((await s.call("PUT", "/v1/review-projects/nope/business-hours", { user: A, body: { businessHours: null } })).status).toBe(404);
    // a one-hour window on every day except today and tomorrow (UTC) → the deadline lands at least 2 days out
    const today = new Date().getUTCDay() || 7;
    const tomorrow = (today % 7) + 1;
    const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today && d !== tomorrow);
    const put = await s.call("PUT", path, {
      user: A,
      body: { businessHours: { timeZone: "UTC", days: [...days, days[0]], start: "10:00", end: "11:00", holidays: ["2030-01-01", "2030-01-01"] } },
    });
    expect(put.json.businessHours).toEqual({ timeZone: "UTC", days, start: "10:00", end: "11:00", holidays: ["2030-01-01"] });
    const r = await s.create({ action: "email.send", externalId: "b1" });
    expect(r.routing.guardrails).not.toContain("business_clock_without_calendar");
    const deadline = new Date(r.deadlineAt);
    expect(deadline.getTime() - Date.now()).toBeGreaterThan(36 * 3600_000);
    expect(deadline.toISOString().slice(11, 16)).toBe("11:00");
    const esc = new Date(r.routing.escalateAt);
    expect(esc.toISOString().slice(11, 16)).toBe("10:30");
    // wall-clock rules are unaffected
    const wall = await s.create({ externalId: "w1" });
    expect(new Date(wall.deadlineAt).getTime() - Date.now()).toBeLessThan(25 * 3600_000);
    expect((await s.call("PUT", path, { user: A, body: { businessHours: null } })).json).toEqual({ businessHours: null });
  });
});
