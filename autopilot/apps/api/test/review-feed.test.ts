import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { __setAgentReviewPollMs } from "../src/routes/agent-reviews.js";
import { bus } from "../src/services/review-feed.js";

const A = "owner-a@example.test",
  R1 = "reviewer-1@example.test";
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
afterEach(() => __setAgentReviewPollMs(null));

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Feed Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: R1, role: "reviewer" } });
  const p1 = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Ops agent" } })).json as { id: string };
  const p2 = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Billing agent" } })).json as { id: string };
  const keyFor = async (projectId: string) =>
    (await call("POST", "/v1/api-keys", { user: A, body: { name: `k-${projectId}`, scopes: ["reviews:write"], projectId } })).json.key as string;
  const k1 = await keyFor(p1.id);
  const k2 = await keyFor(p2.id);
  const create = async (key = k1) =>
    (await call("POST", "/v1/agent-reviews", { headers: bearer(key), body: { action: "email.send", payload: { to: "c@example.test", secret: "x" } } }))
      .json as { id: string };
  const decide = (id: string, decision = "approve") => call("POST", `/v1/agent-reviews/${id}/decisions`, { user: R1, body: { decision } });
  return { ...h, call, p1, p2, k1, k2, create, decide };
}
const sse = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => /^(id|event):/m.test(b))
    .map((b) => {
      const f = Object.fromEntries(b.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
      return { id: f.id as string | undefined, ev: f.event as string, data: JSON.parse(f.data as string) };
    });

describe("R2 live delivery", () => {
  it("/wait returns on the decision push, long before the poll fallback", async () => {
    const s = await setup();
    __setAgentReviewPollMs(10_000);
    const r = await s.create();
    const t0 = Date.now();
    const waiting = s.call("GET", `/v1/agent-reviews/${r.id}/wait?timeoutSeconds=20`, { headers: bearer(s.k1) });
    await new Promise((x) => setTimeout(x, 30));
    await s.decide(r.id);
    const out = await waiting;
    expect(out.json.status).toBe("approved");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(bus.size()).toBe(0);
  });

  it("feed: head cursor, ordered changes after it, no payloads, project-scoped for bound keys", async () => {
    const s = await setup();
    const head = await s.call("GET", "/v1/agent-review/events", { user: A });
    expect(head.json).toEqual({ items: [], cursor: null });
    const a = await s.create();
    const start = (await s.call("GET", "/v1/agent-review/events", { user: A })).json.cursor as string;
    const b = await s.create(s.k2);
    await s.decide(a.id);
    const page = (await s.call("GET", `/v1/agent-review/events?cursor=${start}`, { user: A })).json;
    expect(page.items.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([
      [b.id, "pending"],
      [a.id, "approved"],
    ]);
    expect(JSON.stringify(page)).not.toContain("c@example.test");
    expect(page.cursor).toBe(page.items[1].cursor);
    const again = (await s.call("GET", `/v1/agent-review/events?cursor=${page.cursor}`, { user: A })).json;
    expect(again).toEqual({ items: [], cursor: page.cursor });
    const limited = (await s.call("GET", `/v1/agent-review/events?cursor=${start}&limit=1`, { user: A })).json;
    expect(limited.items).toHaveLength(1);
    const bound = (await s.call("GET", `/v1/agent-review/events?cursor=${start}`, { headers: bearer(s.k1) })).json;
    expect(bound.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    const junk = (await s.call("GET", "/v1/agent-review/events?cursor=!!!", { user: A })).json;
    expect(junk.items.length).toBe(2);
  });

  it("SSE stream: pushes changes with resume ids, honours Last-Event-ID, delivers late commits once", async () => {
    const s = await setup();
    __setAgentReviewPollMs(20);
    const a = await s.create();
    const streaming = s.call("GET", "/v1/agent-review/events/stream?maxSeconds=1", { user: A });
    await new Promise((x) => setTimeout(x, 60));
    const b = await s.create();
    await s.decide(a.id);
    // simulate a commit stamped before the cursor that lands late
    const late = await s.create(s.k2);
    await new Promise((x) => setTimeout(x, 60));
    s.raw
      .prepare("update review_requests set status = 'cancelled', version = version + 1, updated_at = ? where id = ?")
      .run(new Date(Date.now() - 500).toISOString(), late.id);
    const out = await streaming;
    expect(out.headers.get("content-type")).toBe("text/event-stream");
    const evs = sse(out.text);
    const changes = evs.filter((e) => e.ev === "change").map((e) => `${e.data.id === a.id ? "a" : e.data.id === b.id ? "b" : "late"}:${e.data.status}`);
    expect(changes).toEqual(["b:pending", "a:approved", "late:pending", "late:cancelled"]);
    expect(evs.at(-1)!.ev).toBe("end");
    const firstId = evs.find((e) => e.ev === "change")!.id!;
    const resumed = sse((await s.call("GET", "/v1/agent-review/events/stream?maxSeconds=1", { user: A, headers: { "last-event-id": firstId } })).text);
    // `late` is stamped before the resume point, so a resuming client (which already saw it) does not get it again
    expect(resumed.filter((e) => e.ev === "change").map((e) => e.data.id)).toEqual([a.id]);
    const viaQuery = sse((await s.call("GET", `/v1/agent-review/events/stream?maxSeconds=1&cursor=${firstId}`, { headers: bearer(s.k1) })).text);
    expect(viaQuery.filter((e) => e.ev === "change").map((e) => e.data.id)).toEqual([a.id]);
  });

  it("SSE on an empty tenant picks up the first request", async () => {
    const s = await setup();
    __setAgentReviewPollMs(20);
    const streaming = s.call("GET", "/v1/agent-review/events/stream?maxSeconds=1", { user: A });
    await new Promise((x) => setTimeout(x, 60));
    const a = await s.create();
    const evs = sse((await streaming).text);
    expect(evs.filter((e) => e.ev === "change").map((e) => e.data.id)).toEqual([a.id]);
  });
});
