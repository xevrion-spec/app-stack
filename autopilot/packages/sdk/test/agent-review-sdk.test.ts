import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "../../../apps/api/test/harness.js";
import { createApp } from "../../../apps/api/src/app.js";
import { dispatchEvents } from "../../../apps/api/src/services/dispatch.js";
import { __setWebhookFetcher } from "../../../apps/api/src/services/webhooks.js";
import { __setAgentReviewPollMs } from "../../../apps/api/src/routes/agent-reviews.js";
import {
  ReviewClient,
  ReviewApiError,
  ReviewNotApproved,
  verifyCallback,
  verifyReceipt,
  guard,
  withReviewAiSdk,
  withReviewInvoke,
  runToolCalls,
  withReviewMcp,
  type Review,
} from "../src/index.js";

const A = "owner@example.test",
  RV = "reviewer@example.test";
let JWK = "";
async function setup(opts: { fetchWrap?: (f: (r: Request) => Promise<Response>) => (r: Request) => Promise<Response> } = {}) {
  if (!JWK) {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    JWK = JSON.stringify({ ...((await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey), kid: "sdk-test" });
  }
  const h = makeEnv({ RECEIPT_SIGNING_JWK: JWK });
  const call = client(h.env);
  const app = createApp();
  __setAgentReviewPollMs(10);
  await call("POST", "/v1/tenants", { user: A, body: { name: "SDK Co (synthetic)" } });
  await call("POST", "/v1/users", { user: A, body: { email: RV, role: "reviewer" } });
  const project = (await call("POST", "/v1/review-projects", { user: A, body: { name: "Support bot" } })).json as { id: string; callbackSecret: string };
  const apiKey = (await call("POST", "/v1/api-keys", { user: A, body: { name: "agent", scopes: ["reviews:write", "reviews:read"], projectId: project.id } }))
    .json.key as string;
  let requests = 0;
  const base = async (r: Request) => {
    requests++;
    return app.request(r, undefined, h.env);
  };
  const sleeps: number[] = [];
  const sdk = new ReviewClient({
    baseUrl: "http://api.test/",
    apiKey,
    fetch: (opts.fetchWrap ? opts.fetchWrap(base) : base) as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  /** A human reviewer working the queue in the background. */
  const reviewer = (decide: (r: Review) => { decision: string; payload?: Record<string, unknown>; reason?: string } | null) => {
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const items = (await call("GET", "/v1/agent-reviews?status=pending", { user: RV })).json.items as Review[];
        for (const r of items) {
          const d = decide(r);
          if (d) await call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: d });
        }
        await new Promise((x) => setTimeout(x, 5));
      }
    })();
    return async () => {
      stop = true;
      await loop;
    };
  };
  return { ...h, call, sdk, project, apiKey, reviewer, sleeps, count: () => requests };
}
afterEach(() => {
  __setAgentReviewPollMs(null);
  __setWebhookFetcher(null);
});

describe("ReviewClient against the real API", () => {
  it("requestAndWait returns the reviewer-edited payload", async () => {
    const s = await setup();
    const stop = s.reviewer(() => ({ decision: "edit", payload: { to: "c@example.test", body: "softened" } }));
    const r = await s.sdk.requestAndWait({ action: "email.send", payload: { to: "c@example.test", body: "harsh" }, risk: "medium" }, { timeoutMs: 5000 });
    await stop();
    expect([r.status, r.payload, r.payloadVersion]).toEqual(["approved", { to: "c@example.test", body: "softened" }, 2]);
  });

  it("idempotency: same key or externalId returns the same review; a lost response is retried without a duplicate", async () => {
    let dropped = 0;
    const s = await setup({
      fetchWrap: (f) => async (req) => {
        const res = await f(req); // server processes it...
        if (req.method === "POST" && dropped++ === 0) throw new TypeError("network: connection reset"); // ...but the reply is lost
        return res;
      },
    });
    const a = await s.sdk.request({ action: "refund.issue", payload: { amount: 5 }, idempotencyKey: "run-1:step-3" });
    const b = await s.sdk.request({ action: "refund.issue", payload: { amount: 5 }, idempotencyKey: "run-1:step-3" });
    const c = await s.sdk.request({ action: "refund.issue", payload: { amount: 5 }, externalId: "ticket-9" });
    const d = await s.sdk.request({ action: "refund.issue", payload: { amount: 5 }, externalId: "ticket-9" });
    expect([a.id === b.id, c.id === d.id, a.id === c.id]).toEqual([true, true, false]);
    const n = (await s.call("GET", "/v1/agent-reviews", { user: A })).json.items.length;
    expect(n).toBe(2);
    expect(s.sleeps).toHaveLength(1);
    await expect(s.sdk.request({ action: "refund.issue", payload: { amount: 6 }, idempotencyKey: "run-1:step-3" })).rejects.toMatchObject({ status: 409 });
  });

  it("retries 429/5xx honouring Retry-After, then surfaces typed errors without retrying 4xx", async () => {
    let n = 0;
    const s = await setup({
      fetchWrap: (f) => async (req) => {
        n++;
        if (n === 1) return new Response("{}", { status: 503 });
        if (n === 2) return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
        return f(req);
      },
    });
    const r = await s.sdk.request({ action: "a.b", payload: {} });
    expect(r.status).toBe("pending");
    expect(s.sleeps).toEqual([125, 2000]); // full jitter (random 0.5 × 250ms), then Retry-After
    const before = s.count();
    const err = await s.sdk.request({ action: "BAD ACTION", payload: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewApiError);
    expect([(err as ReviewApiError).status, (err as ReviewApiError).code]).toEqual([400, "validation_failed"]);
    expect(s.count() - before).toBe(1);
    await expect(s.sdk.get("missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("gives up after the retry budget on persistent outages", async () => {
    const s = await setup({ fetchWrap: () => async () => new Response("{}", { status: 503 }) });
    await expect(
      new ReviewClient({
        baseUrl: "http://x",
        apiKey: "ap_x",
        fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch,
        retries: 2,
        sleep: async () => {},
      }).get("x"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(s.sdk.get("x")).rejects.toMatchObject({ status: 503 });
    expect(s.sleeps).toHaveLength(4);
    expect(() => new ReviewClient({ baseUrl: "x", apiKey: "" })).toThrow(/apiKey/);
  });

  it("wait times out with the current state when nobody decides", async () => {
    const s = await setup();
    const r = await s.sdk.request({ action: "a.b", payload: {} });
    const w = await s.sdk.wait(r.id, { timeoutMs: 0 });
    expect(w.status).toBe("pending");
    expect((await s.sdk.cancel(r.id, "agent gave up")).status).toBe("cancelled");
  });

  it("verifyCallback accepts the server's real signed callback, supports rotation, rejects tamper and replay", async () => {
    const s = await setup();
    const hits: { headers: Record<string, string>; body: string }[] = [];
    __setWebhookFetcher(async (_url, init) => {
      hits.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("", { status: 200 });
    });
    const r = await s.sdk.request({ action: "a.b", payload: { x: 1 }, callbackUrl: "https://agent.example.test/hook", externalId: "e-1" });
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } });
    for (const m of s.events.splice(0)) await dispatchEvents(s.env, m.tenantId, m.eventIds, () => 0.5);
    const h = hits[0]!;
    const sig = h.headers["autopilot-signature"];
    const ev = await verifyCallback(h.body, sig, ["whsec_old_not_valid", s.project.callbackSecret]);
    expect(ev).toMatchObject({ type: "review.completed", data: { requestId: r.id, status: "approved", payload: { x: 1 }, externalId: "e-1" } });
    await expect(verifyCallback(h.body.replace('"x":1', '"x":2'), sig, [s.project.callbackSecret])).rejects.toThrow("signature mismatch");
    await expect(verifyCallback(h.body, sig, [s.project.callbackSecret], { nowSeconds: Math.floor(Date.now() / 1000) + 3600 })).rejects.toThrow("tolerance");
    await expect(verifyCallback(h.body, "garbage", [s.project.callbackSecret])).rejects.toThrow("malformed");
    await expect(verifyCallback(h.body, null, [s.project.callbackSecret])).rejects.toThrow("malformed");
  });

  it("verifyReceipt verifies the server's real receipt offline and rejects forgeries", async () => {
    const s = await setup();
    const r = await s.sdk.request({ action: "a.b", payload: { x: 1 } });
    await s.call("POST", `/v1/agent-reviews/${r.id}/decisions`, { user: RV, body: { decision: "approve" } });
    const [rec, keys] = await Promise.all([s.sdk.receipt(r.id), s.sdk.receiptKeys()]);
    expect(await verifyReceipt(rec, keys)).toBe(true);
    expect(await verifyReceipt({ ...rec, receipt: { ...rec.receipt, status: "rejected" } }, keys)).toBe(false);
    expect(await verifyReceipt({ ...rec, kid: "other" }, keys)).toBe(false);
    expect(await verifyReceipt({ ...rec, signature: "%%%" }, keys)).toBe(false);
    expect(await verifyReceipt({ ...rec, alg: "none" as "Ed25519" }, keys)).toBe(false);
  });
});

describe("adapters (real API, live reviewer)", () => {
  it("guard runs the tool only on approval, with approved args; throws or maps on rejection; skip bypasses review", async () => {
    const s = await setup();
    const stop = s.reviewer((r) => ((r.payload.amount as number) > 100 ? { decision: "reject", reason: "too much" } : { decision: "approve" }));
    const ran: unknown[] = [];
    const refund = guard(s.sdk, async (a: { amount: number }) => (ran.push(a), `refunded ${a.amount}`), {
      action: "refund.issue",
      risk: (a) => (a.amount > 50 ? "high" : "low"),
    });
    expect(await refund({ amount: 20 })).toBe("refunded 20");
    const err = await refund({ amount: 500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewNotApproved);
    expect((err as ReviewNotApproved).review.status).toBe("rejected");
    const soft = guard(s.sdk, async () => "ran", { action: "refund.issue", onNotApproved: (r) => `blocked:${r.status}` });
    expect(await soft({ amount: 999 })).toBe("blocked:rejected");
    const read = guard(s.sdk, async () => "read", { action: "db.query", skip: () => true });
    expect(await read({})).toBe("read");
    await stop();
    expect(ran).toEqual([{ amount: 20 }]);
  });

  it("AI SDK, LangChain invoke, OpenAI tool calls and MCP handlers", async () => {
    const s = await setup();
    const stop = s.reviewer((r) =>
      r.action === "email.send" ? { decision: "edit", payload: { ...r.payload, cc: "compliance@example.test" } } : { decision: "reject" },
    );
    const aiTool = withReviewAiSdk(
      s.sdk,
      { description: "send", execute: async (a: { to: string; cc?: string }) => `sent to ${a.to} cc ${a.cc}` },
      { action: "email.send" },
    );
    expect(await aiTool.execute!({ to: "a@example.test" } as never, { toolCallId: "tc1" })).toBe("sent to a@example.test cc compliance@example.test");
    expect(aiTool.description).toBe("send");
    expect(() => withReviewAiSdk(s.sdk, {} as { execute?: never }, { action: "x" })).toThrow(/execute/);

    const lc = { name: "wire", other: 42, invoke: async (i: { amount: number }) => `wired ${i.amount}` };
    const guardedLc = withReviewInvoke(s.sdk, lc, { action: "payment.wire", onNotApproved: (r) => `no:${r.status}` });
    expect([guardedLc.name, guardedLc.other]).toEqual(["wire", 42]);
    expect(await guardedLc.invoke({ amount: 1 } as never, { runId: "run-7" } as never)).toBe("no:rejected");

    const out = await runToolCalls(
      s.sdk,
      [
        { id: "1", function: { name: "lookup", arguments: '{"q":"x"}' } },
        { id: "2", function: { name: "email", arguments: '{"to":"b@example.test"}' } },
        { id: "3", function: { name: "wire", arguments: '{"amount":9}' } },
        { id: "4", function: { name: "nope", arguments: "" } },
      ],
      { lookup: async () => "found", email: async (a) => `mailed ${String(a.cc)}`, wire: async () => "wired" },
      { email: { action: "email.send" }, wire: { action: "payment.wire" } },
    );
    expect(out.map((o) => [o.tool_call_id, JSON.parse(o.content)])).toEqual([
      ["1", "found"],
      ["2", "mailed compliance@example.test"],
      ["3", expect.objectContaining({ notApproved: true, status: "rejected" })],
      ["4", { error: "unknown tool nope" }],
    ]);

    const mcp = withReviewMcp(s.sdk, async (a: { amount: number }) => ({ content: [{ type: "text" as const, text: `paid ${a.amount}` }] }), {
      action: "payment.wire",
    });
    expect(await mcp({ amount: 3 }, { requestId: 5 })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("ended rejected") }] });
    await stop();
    // idempotency keys derived from call ids mean replays of the same tool call reuse the same review
    const keyed = guard(s.sdk, async () => "x", { action: "payment.wire", idempotencyKey: (_a, id) => `call:${id}`, timeoutMs: 0, onNotApproved: (r) => r.id });
    const [k1, k2] = [await keyed({ amount: 1 }, "same"), await keyed({ amount: 1 }, "same")];
    expect(k1).toBe(k2);
  });
});
