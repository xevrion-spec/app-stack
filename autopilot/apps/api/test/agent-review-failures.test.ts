import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { sweep, dispatchEvents } from "../src/services/dispatch.js";
import { __setWebhookFetcher } from "../src/services/webhooks.js";
import { sweepAgentReviews } from "../src/services/agent-review.js";
import type { Env } from "../src/env.js";

/** A7b failure paths: infrastructure faults, hostile or broken clients, and time. Every case asserts the system stays consistent. */
const A = "owner@example.test",
  RV = "reviewer@example.test";
afterEach(() => __setWebhookFetcher(null));

async function setup(over: Partial<Env> = {}) {
  const h = makeEnv(over);
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Faults Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: RV, role: "reviewer" } });
  const p = (await call("POST", "/v1/review-projects", { user: A, body: { name: "p" } })).json as { id: string };
  const mkKey = async (projectId: string, scopes = ["reviews:write", "reviews:read"]) =>
    (await call("POST", "/v1/api-keys", { user: A, body: { name: `k${Math.random()}`, scopes, projectId } })).json as { id: string; key: string };
  const k = await mkKey(p.id);
  const bearer = { authorization: `Bearer ${k.key}` };
  const create = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call("POST", "/v1/agent-reviews", { headers: { ...bearer, ...headers }, body: { action: "a.b", payload: { n: 1 }, ...body } });
  const audit = async (id: string) => (await call("GET", `/v1/agent-reviews/${id}/audit`, { user: A })).json.integrity;
  return { ...h, call, p, k, bearer, create, mkKey, audit };
}

describe("agent review failure paths", () => {
  it("queue outage: requests still commit; the outbox sweeper republishes later and delivery completes", async () => {
    let down = true;
    const sent: unknown[] = [];
    const s = await setup({
      PIPELINE: {
        send: async (m: unknown) => {
          if (down) throw new Error("queue unavailable");
          sent.push(m);
        },
        sendBatch: async () => {},
      } as unknown as Env["PIPELINE"],
    });
    const r = await s.create({ callbackUrl: "https://cb.example.test/h" });
    expect(r.status).toBe(201);
    await s.call("POST", `/v1/agent-reviews/${r.json.id}/decisions`, { user: RV, body: { decision: "approve" } });
    expect(sent).toHaveLength(0);
    const hits: string[] = [];
    __setWebhookFetcher(async (u) => (hits.push(u), new Response("", { status: 200 })));
    down = false;
    expect((await sweep(s.env, new Date(Date.now() + 120_000))).republished).toBeGreaterThan(0);
    for (const m of sent.splice(0) as { tenantId: string; eventIds: string[] }[]) await dispatchEvents(s.env, m.tenantId, m.eventIds, () => 0.5);
    expect(hits).toEqual(["https://cb.example.test/h"]);
  });

  it("database failure mid-decision: nothing partial is written and a retry succeeds", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    const realBatch = s.env.DB.batch.bind(s.env.DB);
    let fail = true;
    s.env.DB.batch = (async (stmts: D1PreparedStatement[]) => {
      if (fail) {
        fail = false;
        throw new Error("D1_ERROR: network connection lost");
      }
      return realBatch(stmts);
    }) as typeof s.env.DB.batch;
    const count = (t: string) => (s.raw.prepare(`select count(*) n from ${t}`).get() as { n: number }).n;
    const before = ["review_decisions", "review_ledger", "events", "audit_log"].map(count);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } })).status).toBe(500);
    expect(["review_decisions", "review_ledger", "events", "audit_log"].map(count)).toEqual(before);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } })).json.status).toBe("approved");
    expect(await s.audit(r.id)).toMatchObject({ ok: true, length: 2 });
  });

  it("callback receiver hangs/times out: recorded as failed with a retry, then dead after the retry budget", async () => {
    const s = await setup();
    __setWebhookFetcher(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = (await s.create({ callbackUrl: "https://slow.example.test/h" })).json;
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } });
    for (const m of s.events.splice(0)) await dispatchEvents(s.env, m.tenantId, m.eventIds, () => 0.5);
    const log = async () => (await s.call("GET", `/v1/agent-reviews/${r.id}/callbacks`, { user: A })).json.items[0];
    expect(await log()).toMatchObject({ status: "failed", attempt: 1 });
    let t = Date.now();
    for (let i = 0; i < 20 && (await log()).status !== "dead"; i++) await sweepAgentReviews(s.env, new Date((t += 3 * 86_400_000)));
    expect(await log()).toMatchObject({ status: "dead" });
    expect((await log()).attempt).toBeGreaterThan(3);
  });

  it("maintenance mode: writes refused with 503, reads keep working", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    s.env.MAINTENANCE = "1";
    expect((await s.create()).status).toBe(503);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } })).status).toBe(503);
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: s.bearer })).json.status).toBe("pending");
  });

  it("revoked keys stop at once; keys bound to another project and other tenants see nothing", async () => {
    const s = await setup();
    const r = (await s.create()).json;
    const p2 = (await s.call("POST", "/v1/review-projects", { user: A, body: { name: "other" } })).json;
    const k2 = await s.mkKey(p2.id);
    expect((await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: { authorization: `Bearer ${k2.key}` } })).status).toBe(404);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/cancel`, { headers: { authorization: `Bearer ${k2.key}` }, body: {} })).status).toBe(404);
    expect(
      (await s.call("POST", "/v1/agent-reviews", { headers: { authorization: `Bearer ${k2.key}` }, body: { projectId: s.p.id, action: "a.b", payload: {} } }))
        .status,
    ).toBe(403);
    await s.call("DELETE", `/v1/api-keys/${s.k.id}`, { user: A });
    expect((await s.create()).status).toBe(401);
    await s.call("POST", "/v1/tenants", { user: "eve@example.test", body: { name: "Eve (synthetic)" } });
    for (const path of [`/v1/agent-reviews/${r.id}`, `/v1/agent-reviews/${r.id}/audit`, `/v1/agent-reviews/${r.id}/evidence`])
      expect((await s.call("GET", path, { user: "eve@example.test" })).status, path).toBe(404);
    expect((await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: "eve@example.test", body: { decision: "approve" } })).status).toBe(404);
  });

  it("a decision arriving after the deadline is refused; the request expires exactly once", async () => {
    const s = await setup();
    const r = (await s.create({ timeoutSeconds: 10 })).json;
    s.raw.prepare("update review_requests set deadline_at = '2000-01-01T00:00:00.000Z'").run();
    const late = await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } });
    expect([late.status, late.json.error.code]).toEqual([409, "already_final"]);
    await sweepAgentReviews(s.env);
    const got = (await s.call("GET", `/v1/agent-reviews/${r.id}`, { headers: s.bearer })).json;
    expect([got.status, got.decisions]).toEqual(["expired", []]);
    const kinds = (s.raw.prepare("select kind from review_ledger where request_id = ? order by seq").all(r.id) as { kind: string }[]).map((x) => x.kind);
    expect(kinds).toEqual(["requested", "expired"]);
    expect(await s.audit(r.id)).toMatchObject({ ok: true });
  });

  it("hostile or broken input is rejected cleanly", async () => {
    const s = await setup();
    const big = { blob: "x".repeat(70_000) };
    expect((await s.create({ payload: big })).status).toBe(400);
    const malformed = await s.call("POST", "/v1/agent-reviews", { headers: { ...s.bearer, "content-type": "application/json" }, raw: "{not json" });
    expect(malformed.status).toBe(400);
    expect((await s.create({ action: "a".repeat(200) })).status).toBe(400);
    expect((await s.create({ payload: [1, 2] })).status).toBe(400);
    expect((await s.create({ risk: "catastrophic" })).status).toBe(400);
    expect((await s.create({ minApprovals: 99 })).status).toBe(400);
    expect((await s.create({ deadlineAt: "2001-01-01T00:00:00Z" })).status).toBe(400);
    expect((await s.call("POST", `/v1/agent-reviews/nope/decisions`, { user: RV, body: { decision: "maybe" } })).status).toBe(400);
    expect((await s.call("GET", "/v1/agent-reviews?limit=100000", { headers: s.bearer })).status).toBe(400);
    expect((s.raw.prepare("select count(*) n from review_requests").get() as { n: number }).n).toBe(0);
  });

  it("API keys are rate limited with Retry-After", async () => {
    const s = await setup({ RATE_LIMIT_API_KEY_PER_MINUTE: "3" });
    const codes: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await s.call("GET", "/v1/agent-reviews", { headers: s.bearer });
      codes.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("retry-after");
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
