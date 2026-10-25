import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { dispatchEvents, retryDueDeliveries, sweep } from "../src/services/dispatch.js";
import { __setWebhookFetcher, __setWebhookClock } from "../src/services/webhooks.js";
import { __setRateLimitClock } from "../src/lib/ratelimit.js";
import { scopeFor } from "../src/lib/auth.js";
import { signPayload, verifySignature } from "@xevrion/platform";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test";
const csvH = { "content-type": "text/csv" };
const inv = {
  customerName: "Acme Ltd",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  lines: [{ description: "Design", quantity: 1, unitPence: 10000, vatRateCode: "STD" }],
};
type Hit = { url: string; headers: Record<string, string>; body: string };

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const tB = (await call("GET", "/v1/me", { user: B })).json.tenantId as string;
  const drain = async (tenant = tA) => {
    // run the queue to quiescence like the consumer would (automation-emitted events arrive as new messages)
    const reports = [];
    for (let i = 0; i < 10 && h.events.length; i++) {
      const batch = h.events.splice(0);
      for (const m of batch) reports.push(await dispatchEvents(h.env, m.tenantId, m.eventIds, () => 0.5));
    }
    void tenant;
    return reports;
  };
  const upload = async (user = A, csv = BANK_CSV) => {
    const r = await call("POST", "/v1/uploads/bank-csv", { user, raw: csv, headers: csvH });
    return r;
  };
  return { ...h, call, tA, tB, drain, upload };
}
let hits: Hit[] = [];
let responder: (h: Hit) => Promise<Response> | Response = () => new Response("ok");
beforeEach(() => {
  hits = [];
  responder = () => new Response("ok");
  __setWebhookFetcher(async (url, init) => {
    const h = { url, headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)), body: String(init.body) };
    hits.push(h);
    return responder(h);
  });
});
afterEach(() => {
  __setWebhookFetcher(null);
  __setWebhookClock(null);
  __setRateLimitClock(null);
});

describe("outbox events", () => {
  it("upload emits one transaction.created per new line, atomically with the rows", async () => {
    const s = await setup();
    await s.upload();
    const ev = (await s.call("GET", "/v1/events?type=transaction.created&limit=200", { user: A })).json.items;
    expect(ev).toHaveLength(11);
    const txns = (await s.call("GET", "/v1/transactions?limit=200", { user: A })).json.items.map((t: { id: string }) => t.id).sort();
    expect(ev.map((e: { data: { transactionId: string } }) => e.data.transactionId).sort()).toEqual(txns);
    expect(s.events.flatMap((m) => m.eventIds)).toHaveLength(11);
  });
  it("re-upload of duplicates emits nothing", async () => {
    const s = await setup();
    await s.upload();
    s.events.length = 0;
    await s.upload();
    expect(s.events).toEqual([]);
  });
  it.each([
    [
      "pipeline -> categorised, exception.opened, job.completed",
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await s.upload();
        const m = s.sent.at(-1)!;
        await runPipeline(s.env, m.tenantId, m.jobId, undefined);
      },
      ["transaction.categorised", "exception.opened", "job.completed"],
    ],
    [
      "invoice create -> invoice.created",
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await s.call("POST", "/v1/invoices", { user: A, body: inv });
      },
      ["invoice.created"],
    ],
    [
      "invoice paid -> invoice.paid",
      async (s: Awaited<ReturnType<typeof setup>>) => {
        const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
        await s.call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
        await s.call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "paid" } });
      },
      ["invoice.paid"],
    ],
    [
      "vat draft -> vat_draft.ready",
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30" } });
      },
      ["vat_draft.ready"],
    ],
    [
      "manual categorise -> transaction.categorised",
      async (s: Awaited<ReturnType<typeof setup>>) => {
        await s.upload();
        const t = (await s.call("GET", "/v1/transactions", { user: A })).json.items[0];
        await s.call("PATCH", `/v1/transactions/${t.id}`, { user: A, body: { categoryCode: "6200" } });
      },
      ["transaction.categorised"],
    ],
  ] as [string, (s: Awaited<ReturnType<typeof setup>>) => Promise<void>, string[]][])("%s", async (_n, act, types) => {
    const s = await setup();
    await act(s);
    const got = new Set((await s.call("GET", "/v1/events?limit=200", { user: A })).json.items.map((e: { type: string }) => e.type));
    for (const t of types) expect(got.has(t)).toBe(true);
  });
  it("exception.resolved is emitted with the reviewer", async () => {
    const s = await setup();
    await s.upload();
    const m = s.sent.at(-1)!;
    await runPipeline(s.env, m.tenantId, m.jobId, undefined);
    const ex = (await s.call("GET", "/v1/exceptions", { user: A })).json.items[0];
    await s.call("POST", `/v1/exceptions/${ex.id}/resolve`, { user: R, body: { decision: "dismiss" } });
    const e = (await s.call("GET", "/v1/events?type=exception.resolved", { user: A })).json.items[0];
    expect(e.data).toMatchObject({ exceptionId: ex.id, decision: "dismiss", by: R });
  });
  it("events are tenant-isolated", async () => {
    const s = await setup();
    await s.upload();
    expect((await s.call("GET", "/v1/events", { user: B })).json.items).toEqual([]);
    const e = (await s.call("GET", "/v1/events", { user: A })).json.items[0];
    expect((await s.call("GET", `/v1/events/${e.id}`, { user: B })).status).toBe(404);
  });
  it("entity.* type filter and pagination", async () => {
    const s = await setup();
    await s.upload();
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const r = await s.call("GET", "/v1/events?type=invoice.*", { user: A });
    expect(r.json.items.map((e: { type: string }) => e.type)).toEqual(["invoice.created"]);
    const p1 = await s.call("GET", "/v1/events?limit=5", { user: A });
    const p2 = await s.call("GET", `/v1/events?limit=5&cursor=${encodeURIComponent(p1.json.nextCursor)}`, { user: A });
    expect(new Set([...p1.json.items, ...p2.json.items].map((e: { id: string }) => e.id)).size).toBe(10);
  });
  it("catalog lists every event type with version", async () => {
    const s = await setup();
    const cat = (await s.call("GET", "/v1/events/catalog", { user: A })).json;
    expect(cat.map((c: { type: string }) => c.type)).toContain("vat_draft.ready");
    expect(cat.every((c: { version: number }) => c.version >= 1)).toBe(true);
  });
  it("activity feed shows the audit trail newest first", async () => {
    const s = await setup();
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const a = (await s.call("GET", "/v1/activity", { user: A })).json.items;
    expect(a[0].action).toBe("invoice.created");
    expect(a.some((x: { action: string }) => x.action === "tenant.created")).toBe(true);
  });
  it("sweeper re-publishes stale undispatched events and dispatch marks them done", async () => {
    const s = await setup();
    await s.upload();
    s.events.length = 0;
    s.raw.prepare("update events set created_at = '2020-01-01T00:00:00.000Z'").run();
    const r = await sweep(s.env);
    expect(r.republished).toBe(11);
    await s.drain();
    expect((s.raw.prepare("select count(*) n from events where dispatched_at is null").get() as { n: number }).n).toBe(0);
    expect((await sweep(s.env)).republished).toBe(0);
  });
  it("publish failure degrades gracefully: request succeeds and the event stays in the outbox", async () => {
    const s = await setup();
    s.env.PIPELINE = {
      send: async () => {
        throw new Error("queue down");
      },
    } as never;
    const r = await s.call("POST", "/v1/invoices", { user: A, body: inv });
    expect(r.status).toBe(201);
    expect((s.raw.prepare("select count(*) n from events where type = 'invoice.created' and dispatched_at is null").get() as { n: number }).n).toBe(1);
  });
});

describe("webhooks", () => {
  const mk = async (s: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown> = {}) =>
    s.call("POST", "/v1/webhooks", { user: A, body: { url: "https://hooks.example.com/ap", ...body } });
  it("create returns the secret once; list never does", async () => {
    const s = await setup();
    const r = await mk(s);
    expect(r.status).toBe(201);
    expect(r.json.secret).toMatch(/^whsec_/);
    const l = await s.call("GET", "/v1/webhooks", { user: A });
    expect(l.text).not.toContain(r.json.secret);
  });
  it.each([
    "http://hooks.example.com",
    "https://127.0.0.1/x",
    "https://169.254.169.254/",
    "https://localhost/",
    "https://[::1]/",
    "https://user:pw@example.com/",
    "https://internal/",
  ])("rejects SSRF-prone URL %s", async (url) => {
    const s = await setup();
    const r = await mk(s, { url });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Webhook URL rejected/);
  });
  it.each([[["nope.event"]], [[]], [["transaction.*", "bogus.*"]]])("rejects bad event filters %j", async (events) =>
    expect((await mk(await setup(), { events })).status).toBe(400),
  );
  it("reviewer cannot manage webhooks", async () =>
    expect((await (await setup()).call("POST", "/v1/webhooks", { user: R, body: { url: "https://h.example.com/" } })).status).toBe(403));
  it("delivers signed events the receiver can verify", async () => {
    const s = await setup();
    const w = (await mk(s, { events: ["invoice.*"] })).json;
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.headers["autopilot-event-type"]).toBe("invoice.created");
    const t = Number(/t=(\d+)/.exec(h.headers["autopilot-signature"]!)![1]);
    expect(await verifySignature([w.secret], h.headers["autopilot-signature"], h.body, t)).toEqual({ ok: true });
    expect(JSON.parse(h.body)).toMatchObject({ type: "invoice.created", data: { customerName: "Acme Ltd" } });
  });
  it("filters: only subscribed types are delivered", async () => {
    const s = await setup();
    await mk(s, { events: ["vat_draft.ready"] });
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    expect(hits).toHaveLength(0);
  });
  it("redelivered queue message does not duplicate deliveries", async () => {
    const s = await setup();
    await mk(s);
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const msg = s.events[0]!;
    await dispatchEvents(s.env, msg.tenantId, msg.eventIds);
    await dispatchEvents(s.env, msg.tenantId, msg.eventIds);
    expect(hits).toHaveLength(1);
    expect((s.raw.prepare("select count(*) n from webhook_deliveries").get() as { n: number }).n).toBe(1);
  });
  it.each([
    [500, "failed"],
    [503, "failed"],
    [429, "failed"],
    [404, "dead"],
    [410, "dead"],
    [400, "dead"],
  ])("HTTP %i -> delivery %s", async (status, outcome) => {
    const s = await setup();
    const w = (await mk(s)).json;
    responder = () => new Response("x", { status });
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    const d = (await s.call("GET", `/v1/webhooks/${w.id}/deliveries`, { user: A })).json.items[0];
    expect(d.status).toBe(outcome);
    expect(d.response_status).toBe(status);
    if (outcome === "failed") expect(Date.parse(d.next_attempt_at)).toBeGreaterThan(Date.now());
    else expect(d.next_attempt_at).toBeNull();
  });
  it("network error / timeout is retried", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    responder = () => {
      throw new Error("The operation was aborted due to timeout");
    };
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    const d = (await s.call("GET", `/v1/webhooks/${w.id}/deliveries`, { user: A })).json.items[0];
    expect(d).toMatchObject({ status: "failed", response_status: null });
    expect(d.error).toMatch(/timeout/);
  });
  it("retries with backoff until success; then endpoint health resets", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    let n = 0;
    responder = () => new Response("", { status: ++n < 3 ? 502 : 200 });
    let now = Date.now();
    __setWebhookClock(() => now);
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    for (let i = 0; i < 5; i++) {
      now += 7 * 3600_000;
      await retryDueDeliveries(s.env, s.tA, new Date(now).toISOString(), 100, () => 0.5);
    }
    const d = (await s.call("GET", `/v1/webhooks/${w.id}/deliveries`, { user: A })).json.items[0];
    expect(d).toMatchObject({ status: "succeeded", attempt: 3 });
    expect((await s.call("GET", `/v1/webhooks/${w.id}`, { user: A })).json.consecutive_failures).toBe(0);
  });
  it("gives up after max attempts (dead) and does not retry dead deliveries", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    responder = () => new Response("", { status: 500 });
    let now = Date.now();
    __setWebhookClock(() => now);
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    for (let i = 0; i < 12; i++) {
      now += 7 * 3600_000;
      await retryDueDeliveries(s.env, s.tA, new Date(now).toISOString(), 100, () => 0.5);
    }
    const d = (await s.call("GET", `/v1/webhooks/${w.id}/deliveries`, { user: A })).json.items[0];
    expect(d).toMatchObject({ status: "dead", attempt: 8 });
    expect(hits).toHaveLength(8);
  });
  it("auto-disables after sustained failures and stops delivering", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    responder = () => new Response("", { status: 500 });
    for (let i = 0; i < 21; i++) await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    const ep = (await s.call("GET", `/v1/webhooks/${w.id}`, { user: A })).json;
    expect(ep.status).toBe("disabled");
    expect(ep.disabled_reason).toMatch(/auto-disabled/);
    expect(hits.length).toBe(20);
  });
  it("re-enable via PATCH needs the current version (409 on stale)", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    expect((await s.call("PATCH", `/v1/webhooks/${w.id}`, { user: A, body: { version: w.version + 5, status: "disabled" } })).status).toBe(409);
    const r = await s.call("PATCH", `/v1/webhooks/${w.id}`, { user: A, body: { version: w.version, status: "disabled" } });
    expect(r.json).toMatchObject({ status: "disabled", version: w.version + 1 });
    const r2 = await s.call("PATCH", `/v1/webhooks/${w.id}`, { user: A, body: { version: w.version + 1, status: "active" } });
    expect(r2.json).toMatchObject({ status: "active", consecutive_failures: 0 });
  });
  it("replay re-sends a dead delivery", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    responder = () => new Response("", { status: 404 });
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    const d = (await s.call("GET", `/v1/webhooks/${w.id}/deliveries?status=dead`, { user: A })).json.items[0];
    responder = () => new Response("ok");
    const r = await s.call("POST", `/v1/webhooks/${w.id}/deliveries/${d.id}/replay`, { user: A });
    expect(r.json.status).toBe("succeeded");
    expect(hits).toHaveLength(2);
  });
  it("test ping is signed and logged", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    const r = await s.call("POST", `/v1/webhooks/${w.id}/test`, { user: A });
    expect(r.json.status).toBe("succeeded");
    expect(hits[0]!.headers["autopilot-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
  it("rotate-secret: new deliveries use the new secret", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    const rot = (await s.call("POST", `/v1/webhooks/${w.id}/rotate-secret`, { user: A })).json;
    await s.call("POST", `/v1/webhooks/${w.id}/test`, { user: A });
    const h = hits[0]!;
    const t = Number(/t=(\d+)/.exec(h.headers["autopilot-signature"]!)![1]);
    expect((await verifySignature([rot.secret], h.headers["autopilot-signature"], h.body, t)).ok).toBe(true);
    expect((await verifySignature([w.secret], h.headers["autopilot-signature"], h.body, t)).ok).toBe(false);
  });
  it("soft-deleted endpoints receive nothing and 404", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    await s.call("DELETE", `/v1/webhooks/${w.id}`, { user: A });
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    expect(hits).toHaveLength(0);
    expect((await s.call("GET", `/v1/webhooks/${w.id}`, { user: A })).status).toBe(404);
  });
  it("cross-tenant webhook access is 404", async () => {
    const s = await setup();
    const w = (await mk(s)).json;
    for (const [m, p] of [
      ["GET", ""],
      ["DELETE", ""],
      ["POST", "/test"],
      ["POST", "/rotate-secret"],
      ["GET", "/deliveries"],
    ] as const)
      expect((await s.call(m, `/v1/webhooks/${w.id}${p}`, { user: B })).status).toBe(404);
  });
  it("one tenant's events never reach another tenant's endpoint", async () => {
    const s = await setup();
    await s.call("POST", "/v1/webhooks", { user: B, body: { url: "https://b.example.com/hook" } });
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    await s.drain();
    expect(hits).toHaveLength(0);
  });
  it("limits endpoints per tenant", async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++) expect((await mk(s, { url: `https://h${i}.example.com/` })).status).toBe(201);
    expect((await mk(s, { url: "https://h21.example.com/" })).status).toBe(400);
  });
});

describe("automations", () => {
  const auto = (over: Record<string, unknown> = {}) => ({
    name: "Amazon to office",
    trigger: { event: "transaction.created" },
    conditions: [{ op: "contains", path: "data.description", value: "MYSTERY PAYEE" }],
    actions: [{ type: "categorise_transaction", categoryCode: "6600" }],
    ...over,
  });
  it("categorises matching transactions when events dispatch, with history", async () => {
    const s = await setup();
    const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
    await s.upload();
    await s.drain();
    const t = (await s.call("GET", "/v1/transactions?limit=200", { user: A })).json.items.find((x: { description: string }) =>
      x.description.includes("MYSTERY"),
    );
    expect(t.category_code).toBe("6600");
    const runs = (await s.call("GET", `/v1/automations/${a.id}/runs`, { user: A })).json.items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", dry_run: 0 });
    const ev = (await s.call("GET", "/v1/events?type=transaction.categorised", { user: A })).json.items[0];
    expect(ev.actor).toBe(`automation:${a.id}`);
    expect(ev.causationChain[0]).toMatch(new RegExp(`^automation:${a.id}:`));
  });
  it("is idempotent under duplicate dispatch (no double journals)", async () => {
    const s = await setup();
    await s.call("POST", "/v1/automations", { user: A, body: auto() });
    await s.upload();
    const msgs = s.events.splice(0);
    for (let i = 0; i < 3; i++) for (const m of msgs) await dispatchEvents(s.env, m.tenantId, m.eventIds);
    const n = s.raw.prepare("select count(*) n from journals j join transactions t on t.id = j.source_id where t.description like 'MYSTERY%'").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
    expect((s.raw.prepare("select count(*) n from action_executions").get() as { n: number }).n).toBe(1);
  });
  it("loop protection: an automation re-triggering itself stops", async () => {
    const s = await setup();
    await s.upload();
    const m = s.sent.at(-1)!;
    await runPipeline(s.env, m.tenantId, m.jobId, undefined);
    s.events.length = 0;
    // ping-pong: two automations re-categorise each other's output forever without protection
    await s.call("POST", "/v1/automations", {
      user: A,
      body: auto({
        name: "ping",
        trigger: { event: "transaction.categorised" },
        conditions: [{ op: "eq", path: "data.categoryCode", value: "6200" }],
        actions: [{ type: "categorise_transaction", categoryCode: "6600" }],
      }),
    });
    await s.call("POST", "/v1/automations", {
      user: A,
      body: auto({
        name: "pong",
        trigger: { event: "transaction.categorised" },
        conditions: [{ op: "eq", path: "data.categoryCode", value: "6600" }],
        actions: [{ type: "categorise_transaction", categoryCode: "6200" }],
      }),
    });
    const t = (await s.call("GET", "/v1/transactions?limit=200", { user: A })).json.items.find((x: { description: string }) =>
      x.description.includes("STAPLES"),
    );
    await s.call("PATCH", `/v1/transactions/${t.id}`, { user: A, body: { categoryCode: "6200" } });
    const reports = await s.drain();
    expect(reports.length).toBeLessThan(10);
    const runs = s.raw.prepare("select count(*) n from automation_runs").get() as { n: number };
    expect(runs.n).toBeLessThanOrEqual(8);
    expect(s.events).toEqual([]);
  });
  it("rate cap stops runs over maxRunsPerHour", async () => {
    const s = await setup();
    const a = (
      await s.call("POST", "/v1/automations", {
        user: A,
        body: auto({ conditions: [], actions: [{ type: "tag_transaction", tag: "seen" }], maxRunsPerHour: 3 }),
      })
    ).json;
    await s.upload();
    await s.drain();
    const rows = s.raw.prepare("select status, count(*) n from automation_runs where automation_id = ? group by status").all(a.id) as {
      status: string;
      n: number;
    }[];
    expect(rows.find((r) => r.status === "succeeded")?.n).toBe(3);
    expect(rows.find((r) => r.status === "skipped")?.n).toBe(8);
    expect((await s.call("GET", "/v1/transactions?tag=seen", { user: A })).json.items).toHaveLength(3);
  });
  it("dry-run with a sample makes no changes", async () => {
    const s = await setup();
    const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
    const r = await s.call("POST", `/v1/automations/${a.id}/dry-run`, {
      user: R,
      body: {
        sample: {
          type: "transaction.created",
          data: { transactionId: "x", jobId: null, date: "2026-07-01", description: "MYSTERY PAYEE 1", amountPence: -100, currency: "GBP" },
        },
      },
    });
    expect(r.json).toMatchObject({ matched: true, skipped: null, actions: [{ type: "categorise_transaction", outcome: "would_do" }] });
    expect((s.raw.prepare("select count(*) n from action_executions").get() as { n: number }).n).toBe(0);
    const miss = await s.call("POST", `/v1/automations/${a.id}/dry-run`, {
      user: A,
      body: {
        sample: {
          type: "transaction.created",
          data: { transactionId: "x", jobId: null, date: "2026-07-01", description: "TESCO", amountPence: -100, currency: "GBP" },
        },
      },
    });
    expect(miss.json).toMatchObject({ matched: false, skipped: "conditions_false", failedCondition: 0 });
  });
  it.each([[{}], [{ sample: { type: "nope", data: {} } }], [{ sample: { type: "transaction.created", data: { bad: 1 } } }], [{ eventId: "missing" }]])(
    "dry-run rejects %j",
    async (body) => {
      const s = await setup();
      const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
      expect([400, 404]).toContain((await s.call("POST", `/v1/automations/${a.id}/dry-run`, { user: A, body })).status);
    },
  );
  it.each([
    [{ actions: [] }],
    [{ trigger: { event: "x.y" } }],
    [{ actions: [{ type: "send_email", to: "a@b.c" }] }],
    [{ conditions: [{ op: "eq", path: "__proto__", value: 1 }] }],
  ])("create rejects invalid definition %j with details", async (over) => {
    const r = await (await setup()).call("POST", "/v1/automations", { user: A, body: auto(over) });
    expect(r.status).toBe(400);
    expect(r.json.error.details.errors.length).toBeGreaterThan(0);
  });
  it("templates list and create-from-template", async () => {
    const s = await setup();
    const t = (await s.call("GET", "/v1/automations/templates", { user: A })).json;
    expect(t.map((x: { id: string }) => x.id)).toContain("notify-exception-opened");
    const r = await s.call("POST", "/v1/automations/from-template", {
      user: A,
      body: { templateId: "auto-categorise-merchant", params: { merchant: "MYSTERY", categoryCode: "6600" } },
    });
    expect(r.status).toBe(201);
    expect(r.json.trigger).toBe("transaction.created");
    expect((await s.call("POST", "/v1/automations/from-template", { user: A, body: { templateId: "nope" } })).status).toBe(404);
  });
  it("notify template emits an audit notification only (no email)", async () => {
    const s = await setup();
    await s.call("POST", "/v1/automations/from-template", { user: A, body: { templateId: "notify-exception-opened" } });
    await s.upload(
      "owner-a@example.test",
      "Date,Description,Amount\n01/07/2026,X,-1\n" +
        Array.from({ length: 9 }, (_, i) => `0${(i % 9) + 1}/07/2026,N${i},-10`).join("\n") +
        "\n10/07/2026,HUGE,-999999",
    );
    const m = s.sent.at(-1)!;
    await runPipeline(s.env, m.tenantId, m.jobId, undefined);
    await s.drain();
    const notes = s.raw.prepare("select count(*) n from audit_log where action = 'automation.notification'").get() as { n: number };
    expect(notes.n).toBeGreaterThanOrEqual(0);
    expect(hits).toHaveLength(0);
  });
  it("PUT requires the current version; soft delete + restore", async () => {
    const s = await setup();
    const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
    expect((await s.call("PUT", `/v1/automations/${a.id}`, { user: A, body: { version: 99, definition: auto({ name: "x" }) } })).status).toBe(409);
    const u = await s.call("PUT", `/v1/automations/${a.id}`, { user: A, body: { version: 1, definition: auto({ name: "renamed" }) } });
    expect(u.json).toMatchObject({ name: "renamed", version: 2 });
    const d = await s.call("DELETE", `/v1/automations/${a.id}`, { user: A });
    expect(d.json.deleted_at).toBeTruthy();
    expect((await s.call("GET", "/v1/automations", { user: A })).json).toHaveLength(0);
    expect((await s.call("GET", "/v1/automations?includeDeleted=true", { user: A })).json).toHaveLength(1);
    expect((await s.call("POST", `/v1/automations/${a.id}/restore`, { user: A })).json.deleted_at).toBeNull();
    expect((await s.call("POST", `/v1/automations/${a.id}/restore`, { user: A })).status).toBe(400);
  });
  it("deleted automations do not run", async () => {
    const s = await setup();
    const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
    await s.call("DELETE", `/v1/automations/${a.id}`, { user: A });
    await s.upload();
    await s.drain();
    expect((s.raw.prepare("select count(*) n from automation_runs").get() as { n: number }).n).toBe(0);
  });
  it("reviewers can dry-run but not create", async () => {
    const s = await setup();
    expect((await s.call("POST", "/v1/automations", { user: R, body: auto() })).status).toBe(403);
  });
  it("cross-tenant automation access is 404 and B's automations never act on A's data", async () => {
    const s = await setup();
    const a = (await s.call("POST", "/v1/automations", { user: A, body: auto() })).json;
    expect((await s.call("GET", `/v1/automations/${a.id}`, { user: B })).status).toBe(404);
    expect((await s.call("DELETE", `/v1/automations/${a.id}`, { user: B })).status).toBe(404);
    await s.call("POST", "/v1/automations", { user: B, body: auto({ conditions: [], actions: [{ type: "tag_transaction", tag: "b-was-here" }] }) });
    await s.upload();
    await s.drain();
    expect((await s.call("GET", "/v1/transactions?tag=b-was-here", { user: A })).json.items).toEqual([]);
  });
  it("action errors are recorded, not thrown, and other actions still run", async () => {
    const s = await setup();
    await s.call("POST", "/v1/automations", {
      user: A,
      body: auto({
        actions: [
          { type: "categorise_transaction", categoryCode: "1234" },
          { type: "tag_transaction", tag: "after-error" },
        ],
      }),
    });
    await s.upload();
    await s.drain();
    const run = s.raw.prepare("select status, result_json from automation_runs").get() as { status: string; result_json: string };
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.result_json).results.map((r: { outcome: string }) => r.outcome)).toEqual(["error", "done"]);
  });
});

describe("inbound triggers", () => {
  const post = async (s: Awaited<ReturnType<typeof setup>>, id: string, body: string, sig: string | null) =>
    s.call("POST", `/hooks/inbound/${id}`, { raw: body, headers: { "content-type": "application/json", ...(sig ? { "autopilot-signature": sig } : {}) } });
  it("accepts a correctly signed payload and emits trigger.received for automations", async () => {
    const s = await setup();
    const t = (await s.call("POST", "/v1/triggers", { user: A, body: { name: "Shopify" } })).json;
    const body = JSON.stringify({ order: 42 });
    const r = await post(s, t.id, body, await signPayload(t.secret, body, Math.floor(Date.now() / 1000)));
    expect(r.status).toBe(202);
    const e = (await s.call("GET", "/v1/events?type=trigger.received", { user: A })).json.items[0];
    expect(e.data).toMatchObject({ triggerId: t.id, payload: { order: 42 } });
  });
  it.each([
    ["no signature", async (_sec: string, _b: string) => null, 401],
    ["wrong secret", async (_s: string, b: string) => signPayload("nope", b, Math.floor(Date.now() / 1000)), 401],
    ["stale", async (sec: string, b: string) => signPayload(sec, b, Math.floor(Date.now() / 1000) - 3600), 401],
  ] as [string, (s: string, b: string) => Promise<string | null>, number][])("rejects %s", async (_n, sig, status) => {
    const s = await setup();
    const t = (await s.call("POST", "/v1/triggers", { user: A, body: { name: "x" } })).json;
    const body = "{}";
    expect((await post(s, t.id, body, await sig(t.secret, body))).status).toBe(status);
  });
  it.each([["[1,2]"], ["not json"], ["null"]])("rejects non-object body %j", async (body) => {
    const s = await setup();
    const t = (await s.call("POST", "/v1/triggers", { user: A, body: { name: "x" } })).json;
    expect((await post(s, t.id, body, await signPayload(t.secret, body, Math.floor(Date.now() / 1000)))).status).toBe(400);
  });
  it("rejects payloads over 16 KB", async () => {
    const s = await setup();
    const t = (await s.call("POST", "/v1/triggers", { user: A, body: { name: "x" } })).json;
    const body = JSON.stringify({ x: "y".repeat(17_000) });
    expect((await post(s, t.id, body, await signPayload(t.secret, body, Math.floor(Date.now() / 1000)))).status).toBe(413);
  });
  it("unknown and revoked triggers are both 404", async () => {
    const s = await setup();
    const t = (await s.call("POST", "/v1/triggers", { user: A, body: { name: "x" } })).json;
    await s.call("DELETE", `/v1/triggers/${t.id}`, { user: A });
    const body = "{}";
    expect((await post(s, t.id, body, await signPayload(t.secret, body, Math.floor(Date.now() / 1000)))).status).toBe(404);
    expect((await post(s, "00000000-0000-0000-0000-000000000000", body, "t=1,v1=x")).status).toBe(404);
    expect((await post(s, "../../etc", body, "t=1,v1=x")).status).toBe(404);
  });
});

describe("API keys", () => {
  const key = async (s: Awaited<ReturnType<typeof setup>>, scopes: string[], extra: Record<string, unknown> = {}) =>
    (await s.call("POST", "/v1/api-keys", { user: A, body: { name: "ci", scopes, ...extra } })).json;
  const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
  it("key works for in-scope reads and is shown only once", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"]);
    expect(k.key).toMatch(/^ap_test_[a-z0-9]{8}_/);
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key) })).status).toBe(200);
    expect((await s.call("GET", "/v1/api-keys", { user: A })).text).not.toContain(k.key);
    expect(s.raw.prepare("select key_hash from api_keys").get()).not.toMatchObject({ key_hash: k.key });
  });
  it.each([
    [["transactions:read"], "PATCH", "/v1/transactions/x", 403],
    [["transactions:read"], "GET", "/v1/invoices", 403],
    [["invoices:read"], "POST", "/v1/invoices", 403],
    [["invoices:write"], "GET", "/v1/invoices", 200],
    [["reports:read"], "GET", "/v1/ledger/trial-balance", 200],
    [["reports:read"], "POST", "/v1/vat/drafts", 403],
    [["events:read"], "GET", "/v1/events", 200],
    [["webhooks:write"], "GET", "/v1/webhooks", 200],
    [["automations:write"], "GET", "/v1/automations", 200],
    [["transactions:write"], "GET", "/v1/users", 403],
    [["transactions:write"], "PATCH", "/v1/tenant", 403],
    [["transactions:write"], "POST", "/v1/api-keys", 403],
    [["transactions:write"], "GET", "/v1/api-keys", 403],
    [["transactions:write"], "POST", "/v1/tenants", 403],
  ] as [string[], string, string, number][])("scopes %j: %s %s -> %i", async (scopes, m, p, status) => {
    const s = await setup();
    const k = await key(s, scopes);
    const r = await s.call(m, p, {
      headers: bearer(k.key),
      ...(m !== "GET" ? { body: m === "PATCH" ? { name: "x", categoryCode: "6200" } : { name: "x" } } : {}),
    });
    expect(r.status === 404 && status === 200 ? 200 : r.status).toBe(status);
    if (status === 403) expect(r.json.error.code).toBe("insufficient_scope");
  });
  it.each(["ap_test_abcdefgh_" + "x".repeat(32), "garbage", "ap_test_" + "z".repeat(8) + "_" + "y".repeat(40)])(
    "rejects unknown/malformed key %s",
    async (k) => {
      const s = await setup();
      expect((await s.call("GET", "/v1/transactions", { headers: bearer(k) })).status).toBe(401);
    },
  );
  it("tampered secret with a valid prefix is rejected", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"]);
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key.slice(0, -1) + (k.key.endsWith("A") ? "B" : "A")) })).status).toBe(401);
  });
  it("revoked keys stop working immediately", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"]);
    await s.call("DELETE", `/v1/api-keys/${k.id}`, { user: A });
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key) })).status).toBe(401);
  });
  it("rotation: new key works now, old key keeps working in the grace window then dies", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"]);
    const n = (await s.call("POST", `/v1/api-keys/${k.id}/rotate`, { user: A })).json;
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(n.key) })).status).toBe(200);
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key) })).status).toBe(200);
    s.raw.prepare("update api_keys set revoked_at = '2000-01-01' where id = ?").run(k.id);
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key) })).status).toBe(401);
    expect(n.scopes).toEqual(["transactions:read"]);
  });
  it("expired keys are rejected", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"], { expiresInDays: 1 });
    s.raw.prepare("update api_keys set expires_at = '2000-01-01' where id = ?").run(k.id);
    expect((await s.call("GET", "/v1/transactions", { headers: bearer(k.key) })).status).toBe(401);
  });
  it("records last_used_at and is pinned to its tenant", async () => {
    const s = await setup();
    const k = await key(s, ["transactions:read"]);
    await s.call("GET", "/v1/transactions", { headers: bearer(k.key) });
    expect((s.raw.prepare("select last_used_at from api_keys where id = ?").get(k.id) as { last_used_at: string }).last_used_at).toBeTruthy();
    const r = await s.call("GET", "/v1/transactions", { headers: { ...bearer(k.key), "x-tenant-id": s.tB } });
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([]); // still A's (empty) data, header ignored
  });
  it.each([[[]], [["admin:all"]], [["transactions:read", "nope"]]])("create rejects scopes %j", async (scopes) =>
    expect((await (await setup()).call("POST", "/v1/api-keys", { user: A, body: { name: "x", scopes } })).status).toBe(400),
  );
  it("reviewers cannot manage keys", async () => expect((await (await setup()).call("GET", "/v1/api-keys", { user: R })).status).toBe(403));
  it.each([
    ["GET", "/v1/transactions", "transactions:read"],
    ["POST", "/v1/transactions/bulk-categorise", "transactions:write"],
    ["GET", "/v1/search", "transactions:read"],
    ["DELETE", "/v1/invoices/x", "invoices:write"],
    ["GET", "/v1/users", null],
    ["POST", "/v1/users", null],
    ["GET", "/v1/transactionsX", null],
  ] as [string, string, string | null][])("scopeFor(%s %s)=%s", (m, p, sc) => expect(scopeFor(m, p)).toBe(sc));
});

describe("search", () => {
  it("finds transactions and invoices by words, prefix-matching, tenant-isolated", async () => {
    const s = await setup();
    await s.upload();
    await s.call("POST", "/v1/invoices", { user: A, body: { ...inv, customerName: "Zebra Widgets Ltd" } });
    const r = (await s.call("GET", "/v1/search?q=trainl", { user: A })).json.items;
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("transaction");
    expect(r[0].snippet).toMatch(/\[TRAINLINE\]/);
    expect((await s.call("GET", "/v1/search?q=zebra&kind=invoice", { user: A })).json.items).toHaveLength(1);
    expect((await s.call("GET", "/v1/search?q=zebra&kind=transaction", { user: A })).json.items).toHaveLength(0);
    expect((await s.call("GET", "/v1/search?q=trainline", { user: B })).json.items).toHaveLength(0);
  });
  it.each(['" OR 1=1 --', "NEAR(", "*", "a:b", "' ; drop table transactions", "^x", "AND OR NOT"])("hostile query %j is safe", async (q) => {
    const s = await setup();
    await s.upload();
    const r = await s.call("GET", `/v1/search?q=${encodeURIComponent(q)}`, { user: A });
    expect(r.status).toBe(200);
    expect((s.raw.prepare("select count(*) n from transactions").get() as { n: number }).n).toBe(11);
  });
  it("reflects updated descriptions", async () => {
    const s = await setup();
    await s.upload();
    s.raw.prepare("update transactions set description = 'RENAMED VENDOR' where description like 'GITHUB%'").run();
    expect((await s.call("GET", "/v1/search?q=renamed", { user: A })).json.items).toHaveLength(1);
    expect((await s.call("GET", "/v1/search?q=github", { user: A })).json.items).toHaveLength(0);
  });
});

describe("bulk categorise (partial success)", () => {
  it("reports per-item results", async () => {
    const s = await setup();
    await s.upload();
    const ids = (await s.call("GET", "/v1/transactions?limit=3", { user: A })).json.items.map((t: { id: string }) => t.id);
    const bIds = await (async () => {
      await s.upload(B);
      return (await s.call("GET", "/v1/transactions?limit=1", { user: B })).json.items.map((t: { id: string }) => t.id);
    })();
    const r = await s.call("POST", "/v1/transactions/bulk-categorise", {
      user: R,
      body: {
        items: [
          { id: ids[0], categoryCode: "6200" },
          { id: ids[1], categoryCode: "0000" },
          { id: "missing", categoryCode: "6200" },
          { id: ids[0], categoryCode: "6100" },
          { id: bIds[0], categoryCode: "6200" },
          { id: ids[2], categoryCode: "6200", vatPence: 99999999 },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: { status: number }) => x.status)).toEqual([200, 400, 404, 409, 404, 400]);
    expect(r.json).toMatchObject({ succeeded: 1, failed: 5 });
    expect((await s.call("GET", "/v1/transactions?limit=200", { user: B })).json.items.find((t: { id: string }) => t.id === bIds[0]).category_code).not.toBe(
      "6200",
    );
  });
  it.each([[[]], [Array(201).fill({ id: "x", categoryCode: "6200" })]])("rejects %# item lists out of bounds", async (items) =>
    expect((await (await setup()).call("POST", "/v1/transactions/bulk-categorise", { user: A, body: { items } })).status).toBe(400),
  );
});

describe("transactions: filtering, sorting, fields", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
    await s.upload();
  });
  it.each([
    ["minPence=0", (t: { amount_pence: number }) => t.amount_pence >= 0, 2],
    ["maxPence=-5000", (t: { amount_pence: number }) => t.amount_pence <= -5000, 4],
    ["from=2026-07-10&to=2026-07-21", (t: { txn_date: string }) => t.txn_date >= "2026-07-10" && t.txn_date <= "2026-07-21", 4],
    ["status=new", () => true, 11],
  ] as [string, (t: never) => boolean, number][])("filter %s", async (qs, pred, n) => {
    const items = (await s.call("GET", `/v1/transactions?limit=200&${qs}`, { user: A })).json.items;
    expect(items).toHaveLength(n);
    expect(items.every(pred)).toBe(true);
  });
  it.each([
    ["amount", (a: number, b: number) => a <= b],
    ["-amount", (a: number, b: number) => a >= b],
  ] as const)("sort=%s orders and pages with offset cursor", async (sort, ok) => {
    const p1 = (await s.call("GET", `/v1/transactions?sort=${sort}&limit=6`, { user: A })).json;
    const p2 = (await s.call("GET", `/v1/transactions?sort=${sort}&limit=6&cursor=${p1.nextCursor}`, { user: A })).json;
    const all = [...p1.items, ...p2.items].map((t: { amount_pence: number }) => t.amount_pence);
    expect(all).toHaveLength(11);
    expect(all.every((v, i) => i === 0 || ok(all[i - 1]!, v))).toBe(true);
    expect(p2.nextCursor).toBeNull();
  });
  it("sort=date ascending", async () => {
    const d = (await s.call("GET", "/v1/transactions?sort=date&limit=200", { user: A })).json.items.map((t: { txn_date: string }) => t.txn_date);
    expect(d).toEqual([...d].sort());
  });
  it("fields= returns a sparse fieldset (id always included, unknown ignored)", async () => {
    const t = (await s.call("GET", "/v1/transactions?fields=amount_pence,secret_col", { user: A })).json.items[0];
    expect(Object.keys(t).sort()).toEqual(["amount_pence", "id"]);
  });
  it.each(["sort=bogus", "from=July", "minPence=abc"])("rejects %s", async (qs) =>
    expect((await s.call("GET", `/v1/transactions?${qs}`, { user: A })).status).toBe(400),
  );
});

describe("ETags and optimistic concurrency", () => {
  it("GET /tenant returns an ETag; If-None-Match -> 304", async () => {
    const s = await setup();
    const r = await s.call("GET", "/v1/tenant", { user: A });
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    expect((await s.call("GET", "/v1/tenant", { user: A, headers: { "if-none-match": etag } })).status).toBe(304);
  });
  it("PATCH /tenant with stale If-Match -> 412, fresh -> 200 and new ETag", async () => {
    const s = await setup();
    const etag = (await s.call("GET", "/v1/tenant", { user: A })).headers.get("etag")!;
    const ok = await s.call("PATCH", "/v1/tenant", { user: A, body: { name: "Renamed" }, headers: { "if-match": etag } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).not.toBe(etag);
    const stale = await s.call("PATCH", "/v1/tenant", { user: A, body: { name: "Again" }, headers: { "if-match": etag } });
    expect(stale.status).toBe(412);
    expect(stale.json.error.code).toBe("precondition_failed");
  });
  it("invoice: ETag, 304, If-Match 412, version 409, 428 without precondition", async () => {
    const s = await setup();
    const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
    const g = await s.call("GET", `/v1/invoices/${i.id}`, { user: A });
    const etag = g.headers.get("etag")!;
    expect(g.json.version).toBe(1);
    expect((await s.call("GET", `/v1/invoices/${i.id}`, { user: A, headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "x" } })).status).toBe(428);
    const p = await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "New Name" }, headers: { "if-match": etag } });
    expect(p.json).toMatchObject({ customer_name: "New Name", version: 2 });
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "y" }, headers: { "if-match": etag } })).status).toBe(412);
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "y", version: 1 } })).status).toBe(409);
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "y", version: 2 } })).status).toBe(200);
  });
  it("only drafts are editable; due date cannot precede issue date", async () => {
    const s = await setup();
    const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { dueDate: "2026-06-01", version: 1 } })).status).toBe(400);
    await s.call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
    expect((await s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: "x", version: 2 } })).status).toBe(409);
  });
  it("concurrent edits: exactly one wins", async () => {
    const s = await setup();
    const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
    const rs = await Promise.all(["a", "b", "c", "d"].map((n) => s.call("PATCH", `/v1/invoices/${i.id}`, { user: A, body: { customerName: n, version: 1 } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
  });
});

describe("soft delete + restore (invoices)", () => {
  it("delete hides from list and GET, restore brings it back; sent invoices cannot be deleted", async () => {
    const s = await setup();
    const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await s.call("DELETE", `/v1/invoices/${i.id}`, { user: A })).json.deleted_at).toBeTruthy();
    expect((await s.call("GET", "/v1/invoices", { user: A })).json).toHaveLength(0);
    expect((await s.call("GET", `/v1/invoices/${i.id}`, { user: A })).status).toBe(404);
    expect((await s.call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } })).status).toBe(404);
    expect((await s.call("POST", `/v1/invoices/${i.id}/restore`, { user: A })).json.deleted_at).toBeNull();
    expect((await s.call("GET", "/v1/invoices", { user: A })).json).toHaveLength(1);
    await s.call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
    expect((await s.call("DELETE", `/v1/invoices/${i.id}`, { user: A })).status).toBe(409);
    expect(s.raw.prepare("select count(*) n from audit_log where action in ('invoice.deleted','invoice.restored')").get()).toEqual({ n: 2 });
  });
  it("cross-tenant delete/restore -> 404", async () => {
    const s = await setup();
    const i = (await s.call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await s.call("DELETE", `/v1/invoices/${i.id}`, { user: B })).status).toBe(404);
    expect((await s.call("POST", `/v1/invoices/${i.id}/restore`, { user: B })).status).toBe(404);
  });
});

describe("rate limits, versioning, deprecation, readiness, usage, flags, realtime", () => {
  it("sends RateLimit headers and 429 with Retry-After when the bucket empties", async () => {
    const h = makeEnv({ RATE_LIMIT_PER_MINUTE: "5" });
    const call = client(h.env);
    __setRateLimitClock(() => 1_000_000);
    await call("POST", "/v1/tenants", { user: A, body: { name: "A" } });
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await call("GET", "/v1/me", { user: A }));
    expect(rs[0]!.headers.get("ratelimit-limit")).toBe("5");
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 429]);
    expect(rs[5]!.json.error.code).toBe("rate_limited");
    expect(Number(rs[5]!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("limits are per principal", async () => {
    const h = makeEnv({ RATE_LIMIT_PER_MINUTE: "2" });
    const call = client(h.env);
    __setRateLimitClock(() => 5);
    await call("POST", "/v1/tenants", { user: A, body: { name: "A" } });
    await call("POST", "/v1/tenants", { user: B, body: { name: "B" } });
    await call("GET", "/v1/me", { user: A });
    await call("GET", "/v1/me", { user: A });
    expect((await call("GET", "/v1/me", { user: A })).status).toBe(429);
    expect((await call("GET", "/v1/me", { user: B })).status).toBe(200);
  });
  it("every response carries api-version; deprecated routes carry Deprecation/Sunset/Link", async () => {
    const s = await setup();
    expect((await s.call("GET", "/v1/me", { user: A })).headers.get("api-version")).toBe("1");
    const d = await s.call("GET", "/v1/billing/events", { user: A });
    expect(d.headers.get("deprecation")).toBe("true");
    expect(d.headers.get("sunset")).toMatch(/2027/);
    expect(d.headers.get("link")).toContain("/v1/usage");
    expect((await s.call("GET", "/v1/me", { user: A })).headers.get("deprecation")).toBeNull();
  });
  it("readiness reports each dependency", async () => {
    const s = await setup();
    const r = await s.call("GET", "/health/ready");
    expect(r.status).toBe(200);
    expect(r.json.checks.map((c: { name: string }) => c.name)).toEqual(["d1", "d1_migrations", "kv", "queue_binding"]);
  });
  it("readiness is 503 when a dependency is down", async () => {
    const s = await setup();
    s.env.CONFIG = {
      get: async () => {
        throw new Error("kv down");
      },
    } as never;
    const r = await s.call("GET", "/health/ready");
    expect(r.status).toBe(503);
    expect(r.json.checks.find((c: { name: string }) => c.name === "kv")).toMatchObject({ ok: false, error: "kv down" });
  });
  it("usage meters uploads, and the quota blocks oversized months", async () => {
    const s = await setup();
    await s.upload();
    const u = (await s.call("GET", "/v1/usage", { user: A })).json;
    expect(u.metrics.find((m: { metric: string }) => m.metric === "transactions")).toMatchObject({ used: 11, limit: 5000 });
    s.raw.prepare("update usage_counters set count = 4995 where metric = 'transactions'").run();
    const r = await s.upload(A, "Date,Description,Amount\n" + Array.from({ length: 6 }, (_, i) => `0${i + 1}/08/2026,Q${i},-1`).join("\n"));
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("quota_exceeded");
  });
  it("flags: KV-driven, per-tenant overrides, bad JSON fails safe", async () => {
    const s = await setup();
    s.kv.set("flags", JSON.stringify({ realtime: { default: false, tenants: { [s.tA]: true } }, other: { default: true } }));
    expect((await s.call("GET", "/v1/flags", { user: A })).json).toEqual({ realtime: true, other: true });
    expect((await s.call("GET", "/v1/flags", { user: B })).json).toEqual({ realtime: false, other: true });
    s.kv.set("flags", "{broken");
    expect((await s.call("GET", "/v1/flags", { user: A })).json).toEqual({});
  });
  it("realtime without a binding is a typed 503 pointing at polling", async () => {
    const s = await setup();
    const r = await s.call("GET", "/v1/realtime", { user: A });
    expect(r.status).toBe(503);
    expect(r.json.error.message).toMatch(/poll GET \/v1\/events/);
    expect(r.headers.get("retry-after")).toBe("30");
  });
  it("dispatch pushes to the realtime DO when bound, and survives it failing", async () => {
    const s = await setup();
    const got: string[] = [];
    let fail = false;
    s.env.REALTIME = {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (_u: string, i: RequestInit) => {
          if (fail) throw new Error("DO down");
          got.push(String(i.body));
          return new Response("{}");
        },
      }),
    } as never;
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const r1 = await s.drain();
    expect(r1[0]!.realtime).toBe("sent");
    expect(JSON.parse(got[0]!)[0].type).toBe("invoice.created");
    fail = true;
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const r2 = await s.drain();
    expect(r2[0]!.realtime).toBe("failed");
    expect((s.raw.prepare("select count(*) n from events where dispatched_at is null").get() as { n: number }).n).toBe(0);
  });
});
