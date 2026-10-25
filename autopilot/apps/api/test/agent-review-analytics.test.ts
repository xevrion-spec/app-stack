import { describe, it, expect } from "vitest";
import { makeEnv, client } from "./harness.js";

const A = "owner-an@example.test",
  R1 = "rev1-an@example.test",
  R2 = "rev2-an@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Analytics Co (synthetic)" } });
  h.raw.prepare("update tenants set plan = 'pro'").run();
  for (const e of [R1, R2]) await call("POST", "/v1/users", { user: A, body: { email: e, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "an" } })).json;
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "k", scopes: ["reviews:write"], projectId: p.id } })).json.key as string;
  const create = async (body: Record<string, unknown>) =>
    (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "email.send", payload: { to: "x@example.test" }, risk: "low", ...body } }))
      .json.id as string;
  const decide = (id: string, user: string, decision: string) => call("POST", `/v1/agent-reviews/${id}/decisions`, { user, body: { decision } });
  return { ...h, call, create, decide, projectId: p.id as string };
}

describe("D3 reviewer analytics + D4 auto-approve suggestions", () => {
  it("reports per-reviewer stats, owner-only, with low-sample suppression and project filter", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) await s.decide(await s.create({ confidence: 0.9 }), R1, "approve");
    await s.decide(await s.create({}), R2, "reject");
    const r = await s.call("GET", "/v1/agent-review/analytics/reviewers?days=7", { user: A });
    expect(r.status).toBe(200);
    expect(r.json.minSample).toBe(10);
    expect(r.json.truncated).toBe(false);
    const [one, two] = r.json.reviewers;
    expect(one).toMatchObject({ reviewer: R1, decisions: 12, approveRate: 1, flags: ["fast_approvals"] });
    expect(two).toMatchObject({ reviewer: R2, decisions: 1, approveRate: null, flags: ["low_sample"] });
    expect((await s.call("GET", `/v1/agent-review/analytics/reviewers?projectId=nope`, { user: A })).json.reviewers).toEqual([]);
    expect((await s.call("GET", `/v1/agent-review/analytics/reviewers?projectId=${s.projectId}`, { user: A })).json.reviewers).toHaveLength(2);
    expect((await s.call("GET", "/v1/agent-review/analytics/reviewers", { user: R1 })).status).toBe(403);
    expect((await s.call("GET", "/v1/agent-review/analytics/reviewers?days=0", { user: A })).status).toBe(400);
  });

  it("suggests a guarded rule from human history, returns a valid unsaved draft that the simulator accepts", async () => {
    const s = await setup();
    const base = `/v1/review-projects/${s.projectId}/suggestions`;
    expect((await s.call("GET", base, { user: A })).json).toMatchObject({ considered: 0, suggestions: [], draft: null, basedOnVersion: null });
    for (let i = 0; i < 40; i++) await s.decide(await s.create({ confidence: 0.9 + (i % 10) / 100 }), R1, "approve");
    for (let i = 0; i < 25; i++) await s.decide(await s.create({ risk: "high", confidence: 0.99 }), R1, "approve");
    await s.decide(await s.create({ confidence: 0.2 }), R1, "reject");
    const r = await s.call("GET", `${base}?minSample=20&target=0.9`, { user: A });
    expect(r.status).toBe(200);
    expect(r.json.considered).toBe(66);
    expect(r.json.suggestions).toHaveLength(1);
    const [sg] = r.json.suggestions;
    expect(sg).toMatchObject({ action: "email.send", risk: "low", minConfidence: 0.9, sample: 40, cleanApprovals: 40 });
    expect(sg.shadow).toEqual({ wouldAutoApprove: 40, wouldHaveBeenRejected: 0, wouldHaveBeenEdited: 0, excludedLowConfidence: 1 });
    const sim = await s.call("POST", "/v1/agent-reviews/simulate", {
      user: A,
      body: { request: { projectId: s.projectId, action: "email.send", payload: {}, risk: "low", confidence: 0.95 }, document: r.json.draft },
    });
    expect(sim.json.outcome).toBe("auto_approve");
    // nothing was saved: live policy is still the default
    expect((await s.call("GET", `${base}?minSample=20&target=0.9`, { user: A })).json.basedOnVersion).toBeNull();
    // defaults (minSample 50) are stricter
    expect((await s.call("GET", base, { user: A })).json.suggestions).toEqual([]);
    expect((await s.call("GET", `${base}?minSample=5`, { user: A })).status).toBe(400);
    expect((await s.call("GET", "/v1/review-projects/nope/suggestions", { user: A })).status).toBe(404);
    expect((await s.call("GET", base, { user: R1 })).status).toBe(403);
  });

  it("builds on the active policy version and ignores auto-decided requests", async () => {
    const s = await setup();
    const doc = { rules: [{ id: "keep", when: { action: "noop.*", risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    const pol = await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } });
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${pol.json.version}/activate`, { user: A, body: { force: true } });
    for (let i = 0; i < 30; i++) await s.create({ action: "noop.x", confidence: 0.95 });
    for (let i = 0; i < 40; i++) await s.decide(await s.create({ confidence: 0.95 }), R2, "approve");
    const r = await s.call("GET", `/v1/review-projects/${s.projectId}/suggestions?minSample=20&target=0.9`, { user: A });
    expect(r.json.considered).toBe(40);
    expect(r.json.basedOnVersion).toBe(pol.json.version);
    expect(r.json.draft.rules.map((x: { id: string }) => x.id)).toEqual(["suggested-low-email-send", "keep"]);
  });
});

describe("D6 cost / latency / outcome analytics", () => {
  it("summarises per action with customer-supplied cost inputs; owner-only; validates inputs", async () => {
    const s = await setup();
    const doc = { rules: [{ id: "auto", when: { action: "noop.*", risk: ["low"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] };
    const pol = await s.call("POST", `/v1/review-projects/${s.projectId}/policies`, { user: A, body: { document: doc } });
    await s.call("POST", `/v1/review-projects/${s.projectId}/policies/${pol.json.version}/activate`, { user: A, body: { force: true } });
    for (let i = 0; i < 3; i++) await s.create({ action: "noop.x", confidence: 0.95 });
    await s.decide(await s.create({}), R1, "approve");
    await s.decide(await s.create({}), R1, "reject");
    await s.create({});
    const base = "/v1/agent-review/analytics/outcomes";
    const r = await s.call("GET", `${base}?hourlyCost=60&minutesPerDecision=3&currency=GBP`, { user: A });
    expect(r.status).toBe(200);
    expect(r.json.currency).toBe("GBP");
    expect(r.json.total).toMatchObject({ requests: 6, humanDecisions: 2, autoDecidedRate: 0.5, estimatedHumanCost: 6 });
    expect(r.json.byAction.map((x: { action: string }) => x.action)).toEqual(["email.send", "noop.x"]);
    // policy auto-decisions are not people: D3 must not list them as reviewers
    const revs = (await s.call("GET", "/v1/agent-review/analytics/reviewers", { user: A })).json.reviewers.map((x: { reviewer: string }) => x.reviewer);
    expect(revs).toEqual([R1]);
    expect(r.json.byAction[0].outcomes).toMatchObject({ approved: 1, rejected: 1, pending: 1 });
    expect(r.json.byAction[0].decisionLatency.p50Seconds).toBeGreaterThanOrEqual(0);
    const nocost = (await s.call("GET", `${base}?currency=GBP`, { user: A })).json;
    expect(nocost.currency).toBeNull();
    expect(nocost.total.estimatedHumanCost).toBeNull();
    expect((await s.call("GET", `${base}?projectId=nope`, { user: A })).json.total).toBeNull();
    expect((await s.call("GET", `${base}?currency=pounds`, { user: A })).status).toBe(400);
    expect((await s.call("GET", `${base}?hourlyCost=-1`, { user: A })).status).toBe(400);
    expect((await s.call("GET", base, { user: R1 })).status).toBe(403);
  });
});
