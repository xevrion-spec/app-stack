import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-use@example.test",
  R1 = "reviewer-use@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Usage Co (synthetic)" } });
  h.raw.prepare("update tenants set plan = 'free'").run(); // new tenants start on trial (= starter limits)
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "u" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key as string;
  const create = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call("POST", "/v1/agent-reviews", { headers: { ...bearer(key), ...headers }, body: { action: "refund.issue", payload: { amount: 5 }, ...body } });
  const usage = async () => (await call("GET", "/v1/agent-review/usage", { user: A })).json;
  return { ...h, call, create, usage, projectId: p.id as string };
}

describe("agent review metering + quota (A10a)", () => {
  it("counts new requests, auto decisions and human decisions; idempotent replays are free", async () => {
    const s = await setup();
    expect(await s.usage()).toMatchObject({ plan: "free", requests: 0, autoDecided: 0, humanDecisions: 0, autoRate: null, limit: 1000, remaining: 1000 });
    const doc = { rules: [{ id: "small", when: { action: "refund.*", risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    const pol = await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } });
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${pol.json.version}/activate`, { user: A, body: { force: true } });
    const auto = await s.create({ risk: "low", confidence: 0.95 });
    const human = await s.create({ risk: "high" }, { "idempotency-key": "k1" });
    expect((await s.create({ risk: "high" }, { "idempotency-key": "k1" })).json.id).toBe(human.json.id);
    await s.call("POST", `/v1/agent-reviews/${human.json.id}/decisions`, { user: R1, body: { decision: "approve" } });
    expect(auto.json.status).toBe("approved");
    const autoCount = 1;
    expect(await s.usage()).toMatchObject({ requests: 2, autoDecided: autoCount, humanDecisions: 1, remaining: 998, autoRate: autoCount / 2 });
    // simulate does not meter
    await s.call("POST", "/v1/agent-reviews/simulate", { user: A, body: { projectId: s.projectId, action: "refund.issue", payload: {}, risk: "low" } });
    expect((await s.usage()).requests).toBe(2);
    expect((await s.call("GET", "/v1/agent-review/usage", { user: R1 })).status).toBe(403);
  });

  it("enforces the monthly plan quota with 429 and writes nothing; a higher plan lifts it", async () => {
    const s = await setup();
    const period = new Date().toISOString().slice(0, 7);
    const tid = (s.raw.prepare("select id from tenants").get() as { id: string }).id;
    s.raw.prepare("insert into usage_counters (tenant_id, metric, period, count) values (?, 'agent_reviews', ?, 999)").run(tid, period);
    expect((await s.create()).status).toBe(201);
    const before = s.raw
      .prepare("select (select count(*) from review_requests) r, (select count(*) from review_ledger) l, (select count(*) from events) e")
      .get();
    const over = await s.create();
    expect([over.status, over.json.error.code, over.json.error.details]).toEqual([429, "quota_exceeded", { metric: "agent_reviews", limit: 1000 }]);
    expect(
      s.raw.prepare("select (select count(*) from review_requests) r, (select count(*) from review_ledger) l, (select count(*) from events) e").get(),
    ).toEqual(before);
    expect(await s.usage()).toMatchObject({ requests: 1000, remaining: 0 });
    s.raw.prepare("update tenants set plan = 'pro'").run();
    expect((await s.create()).status).toBe(201);
    expect(await s.usage()).toMatchObject({ plan: "pro", requests: 1001, limit: 250000 });
  });
});
