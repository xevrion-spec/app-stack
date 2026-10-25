import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { dispatchEvents } from "../src/services/dispatch.js";
import { __setWebhookFetcher, __setWebhookClock } from "../src/services/webhooks.js";
import { sweepAgentReviews } from "../src/services/agent-review.js";
import { __setAgentReviewPollMs } from "../src/routes/agent-reviews.js";
import { verifySignature } from "@xevrion/platform";

const A = "owner-a@example.test",
  R1 = "reviewer-1@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
type Hit = { url: string; headers: Record<string, string>; body: string };

async function setup(responder: (h: Hit, n: number) => number = () => 200) {
  const h = makeEnv();
  const call = client(h.env);
  const hits: Hit[] = [];
  __setWebhookFetcher(async (url, init) => {
    const hit = { url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)), body: String(init.body) };
    hits.push(hit);
    return new Response("", { status: responder(hit, hits.length) });
  });
  __setAgentReviewPollMs(20);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Delivery Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const project = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Ops agent" } })).json as { id: string; callbackSecret: string };
  const key = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write"], projectId: project.id } })).json.key as string;
  const create = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call("POST", "/v1/agent-reviews", { headers: { ...bearer(key), ...headers }, body: { action: "email.send", payload: { to: "c@example.test" }, ...body } });
  const decide = (id: string, decision = "approve", headers: Record<string, string> = {}) =>
    call("POST", `/v1/agent-reviews/${id}/decisions`, { user: R1, body: { decision }, headers });
  const drain = async () => {
    const reports = [];
    for (let i = 0; i < 10 && h.events.length; i++)
      for (const m of h.events.splice(0)) reports.push(await dispatchEvents(h.env, m.tenantId, m.eventIds, () => 0.5));
    return reports;
  };
  return { ...h, call, hits, project, key, create, decide, drain };
}
afterEach(() => {
  __setWebhookFetcher(null);
  __setWebhookClock(null);
  __setAgentReviewPollMs(null);
});
const now = () => Math.floor(Date.now() / 1000);

describe("agent review delivery (A3)", () => {
  it("review.* events reach subscribed webhooks, signed and verifiable", async () => {
    const s = await setup();
    const w = (await s.call("POST", "/v1/webhooks", { user: A, body: { url: "https://hooks.example.com/reviews", events: ["review.*"] } })).json;
    const r = (await s.create()).json;
    await s.decide(r.id);
    await s.drain();
    const types = s.hits.filter((h) => h.url.includes("hooks.example.com")).map((h) => h.headers["autopilot-event-type"]);
    expect(types).toEqual(["review.requested", "review.decision_recorded", "review.completed"]);
    for (const h of s.hits) expect(await verifySignature([w.secret], h.headers["autopilot-signature"], h.body, now())).toEqual({ ok: true });
  });

  it("per-request callback: signed with the project secret, carries the approved payload, never duplicated", async () => {
    const s = await setup();
    const r = (await s.create({ callbackUrl: "https://agent.example.test/cb", externalId: "run-7" })).json;
    await s.drain();
    expect(s.hits).toHaveLength(0); // nothing until final
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: R1, body: { decision: "edit", payload: { to: "fixed@example.test" } } });
    const reports = await s.drain();
    expect(reports.some((x) => x.callbacks?.succeeded === 1)).toBe(true);
    expect(s.hits).toHaveLength(1);
    const h = s.hits[0]!;
    expect(await verifySignature([s.project.callbackSecret], h.headers["autopilot-signature"], h.body, now())).toEqual({ ok: true });
    const body = JSON.parse(h.body);
    expect(body).toMatchObject({
      type: "review.completed",
      data: { requestId: r.id, status: "approved", payload: { to: "fixed@example.test" }, payloadVersion: 2, externalId: "run-7" },
    });
    expect(h.headers["autopilot-callback-id"]).toBe(body.id);
    // re-dispatching the same events (at-least-once queue) does not enqueue a second callback
    const evIds = (await s.env.DB.prepare("select id from events where type = 'review.completed'").all<{ id: string }>()).results.map((e) => e.id);
    const tenant = (await s.call("GET", "/v1/me", { user: A })).json.tenantId;
    await dispatchEvents(s.env, tenant, evIds);
    expect(s.hits).toHaveLength(1);
    const log = (await s.call("GET", `/v1/agent-reviews/${r.id}/callbacks`, { headers: bearer(s.key) })).json.items;
    expect(log).toMatchObject([{ status: "succeeded", attempt: 1, responseStatus: 200, eventType: "review.completed" }]);
  });

  it("auto-approved requests call back immediately; rotation changes the signing secret", async () => {
    const s = await setup();
    await s.call("POST", `/v1/review-projects/${s.project.id}/policies`, {
      user: A,
      body: { document: { rules: [{ id: "low", when: { risk: ["low"], minConfidence: 0.8 }, then: { outcome: "auto_approve" } }] } },
    });
    await s.call("POST", `/v1/review-projects/${s.project.id}/policies/1/activate`, { user: A, body: {} });
    const rot = (await s.call("POST", `/v1/review-projects/${s.project.id}/rotate-callback-secret`, { user: A })).json;
    expect(rot.callbackSecret).not.toBe(s.project.callbackSecret);
    await s.create({ risk: "low", confidence: 0.9, callbackUrl: "https://agent.example.test/cb" });
    await s.drain();
    expect(s.hits).toHaveLength(1);
    expect((await verifySignature([rot.callbackSecret], s.hits[0]!.headers["autopilot-signature"], s.hits[0]!.body, now())).ok).toBe(true);
    expect((await verifySignature([s.project.callbackSecret], s.hits[0]!.headers["autopilot-signature"], s.hits[0]!.body, now())).ok).toBe(false);
    expect((await s.call("POST", `/v1/review-projects/${s.project.id}/rotate-callback-secret`, { headers: bearer(s.key) })).status).toBe(403);
  });

  it("retries with backoff, dead-letters non-retryable failures, and redelivers on demand", async () => {
    let mode: "flaky" | "gone" | "ok" = "flaky";
    const s = await setup((_h, n) => (mode === "flaky" ? (n === 1 ? 503 : 200) : mode === "gone" ? 410 : 200));
    const r = (await s.create({ callbackUrl: "https://agent.example.test/cb" })).json;
    await s.decide(r.id);
    await s.drain();
    let log = (await s.call("GET", `/v1/agent-reviews/${r.id}/callbacks`, { user: A })).json.items[0];
    expect(log).toMatchObject({ status: "failed", attempt: 1, responseStatus: 503 });
    expect(Date.parse(log.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect((await sweepAgentReviews(s.env, new Date(Date.now() + 3600_000))).callbacks).toBe(1);
    log = (await s.call("GET", `/v1/agent-reviews/${r.id}/callbacks`, { user: A })).json.items[0];
    expect(log).toMatchObject({ status: "succeeded", attempt: 2 });
    // non-retryable: 410 goes straight to dead; redeliver works once the receiver is fixed
    mode = "gone";
    const g = (await s.create({ callbackUrl: "https://agent.example.test/gone" })).json;
    await s.decide(g.id, "reject");
    await s.drain();
    expect((await s.call("GET", `/v1/agent-reviews/${g.id}/callbacks`, { user: A })).json.items[0]).toMatchObject({ status: "dead", error: "http_410" });
    mode = "ok";
    const re = (await s.call("POST", `/v1/agent-reviews/${g.id}/callbacks/redeliver`, { headers: bearer(s.key) })).json.items[0];
    expect(re).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(JSON.parse(s.hits[s.hits.length - 1]!.body).data.status).toBe("rejected");
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/callbacks/redeliver`, { user: A })).status).toBe(200);
    const none = (await s.create()).json;
    expect((await s.call("POST", `/v1/agent-reviews/${none.id}/callbacks/redeliver`, { user: A })).status).toBe(404);
  });

  it("SSRF guard: private, loopback and plain-http callback URLs are refused at create", async () => {
    const s = await setup();
    for (const url of ["http://agent.example.test/cb", "https://127.0.0.1/cb", "https://10.0.0.5/cb", "https://169.254.169.254/latest", "https://localhost/cb"])
      expect((await s.create({ callbackUrl: url })).status, url).toBe(400);
  });

  it("long-poll wait returns at once when final, times out with the current state, and wakes on a decision", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    const pending = await s.call("GET", `/v1/agent-reviews/${r.id}/wait?timeoutSeconds=0`, { headers: bearer(s.key) });
    expect([pending.json.status, pending.headers.get("x-review-final")]).toEqual(["pending", "false"]);
    const t0 = Date.now();
    const waiting = s.call("GET", `/v1/agent-reviews/${r.id}/wait?timeoutSeconds=5`, { headers: bearer(s.key) });
    await new Promise((res) => setTimeout(res, 60));
    await s.decide(r.id);
    const woke = await waiting;
    expect([woke.json.status, woke.headers.get("x-review-final")]).toEqual(["approved", "true"]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}/wait`, { headers: bearer(s.key) })).json.status).toBe("approved");
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}/wait?timeoutSeconds=99`, { headers: bearer(s.key) })).status).toBe(400);
  });

  it("server-sent events stream state changes until final", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    const res = s.call("GET", `/v1/agent-reviews/${r.id}/stream`, { headers: bearer(s.key) });
    await new Promise((x) => setTimeout(x, 60));
    await s.decide(r.id);
    const out = await res;
    expect(out.headers.get("content-type")).toBe("text/event-stream");
    const events = out.text
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => ({ ev: b.split("\n")[0]!.slice(7), data: JSON.parse(b.split("\n")[1]!.slice(6)) }));
    expect(events.map((e) => (e.ev === "review" ? e.data.status : `end:${e.data.reason}`))).toEqual(["pending", "approved", "end:final"]);
    const timeout = await s.call("GET", `/v1/agent-reviews/${(await s.create()).json.id}/stream?maxSeconds=1`, { headers: bearer(s.key) });
    expect(timeout.text).toContain('"reason":"timeout"');
  });

  it("decisions are idempotent with Idempotency-Key (safe client retries)", async () => {
    const s = await setup();
    const r = (await s.create({ risk: "critical" })).json;
    const a = await s.decide(r.id, "approve", { "idempotency-key": "dec-1" });
    const b = await s.decide(r.id, "approve", { "idempotency-key": "dec-1" });
    expect([a.status, b.status, b.json.approvals]).toEqual([200, 200, 1]);
    expect((await s.decide(r.id, "approve")).json.error.code).toBe("duplicate_decision");
  });
});
