import { describe, it, expect } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { mentionsIn } from "../src/routes/collab.js";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test",
  ACC = "accountant-a@example.test";
async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  await call("POST", "/v1/users", { user: A, body: { email: ACC, role: "accountant" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const setPlan = (plan: string) => h.raw.prepare("update tenants set plan = ? where id = ?").run(plan, tA);
  return { ...h, call, tA, setPlan };
}

describe("accountant role", () => {
  it("can do reviewer work and is reported as accountant", async () => {
    const { call } = await setup();
    expect((await call("GET", "/v1/me", { user: ACC })).json.role).toBe("accountant");
    expect((await call("GET", "/v1/books/recurring", { user: ACC })).status).toBe(200);
    expect(
      (
        await call("POST", "/v1/invoices", {
          user: ACC,
          body: {
            customerName: "x",
            issueDate: "2026-01-01",
            dueDate: "2026-01-02",
            lines: [{ description: "d", quantity: 1, unitPence: 1, vatRateCode: "STD" }],
          },
        })
      ).status,
    ).toBe(403);
  });
  it("seats are limited by plan", async () => {
    const { call, setPlan } = await setup();
    setPlan("free");
    const r = await call("POST", "/v1/users", { user: A, body: { email: "third@example.test", role: "reviewer" } });
    expect(r.status).toBe(429);
    expect(r.json.error.details).toMatchObject({ metric: "seats", limit: 1 });
    expect((await call("POST", "/v1/users", { user: A, body: { email: "co-owner@example.test", role: "owner" } })).status).toBe(201);
  });
});

describe("plan entitlements", () => {
  it("free plan cannot use MTD or recurring invoices; trial can", async () => {
    const { call, setPlan } = await setup();
    expect((await call("GET", "/v1/mtd/obligations?taxYear=2026-27", { user: A })).status).toBe(200);
    setPlan("free");
    const r = await call("GET", "/v1/mtd/obligations?taxYear=2026-27", { user: A });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: "plan_required" });
    expect((await call("GET", "/v1/recurring-invoices", { user: A })).status).toBe(403);
    setPlan("starter");
    expect((await call("GET", "/v1/recurring-invoices", { user: A })).status).toBe(200);
  });
});

describe("comments and mentions", () => {
  it("mentions notify members only, never the author or outsiders; resolve once", async () => {
    const { call } = await setup();
    const c = await call("POST", "/v1/comments", {
      user: A,
      body: { subjectType: "transaction", subjectId: "t1", body: `@${ACC} please check, cc @${A} @outsider@evil.example.test` },
    });
    expect(c.status).toBe(201);
    expect((await call("GET", "/v1/comments?subjectType=transaction&subjectId=t1", { user: R })).json).toHaveLength(1);
    const n = await call("GET", "/v1/notifications", { user: ACC });
    expect(n.json).toMatchObject({ unreadCount: 1 });
    expect(n.json.items[0]).toMatchObject({ kind: "mention", link: "/transaction/t1" });
    expect((await call("GET", "/v1/notifications", { user: A })).json.unreadCount).toBe(0);
    expect((await call("POST", `/v1/comments/${c.json.id}/resolve`, { user: R })).json.resolved_at).toBeTruthy();
    expect((await call("POST", `/v1/comments/${c.json.id}/resolve`, { user: R })).status).toBe(409);
    expect((await call("POST", `/v1/comments/nope/resolve`, { user: R })).status).toBe(404);
    expect((await call("GET", "/v1/comments?subjectType=transaction&subjectId=t1", { user: B })).json).toEqual([]);
  });
  it("mentionsIn parses emails", () => expect(mentionsIn("hi @a.b@x.co and @c@y.org.uk, not @bad")).toEqual(["a.b@x.co", "c@y.org.uk"]));
});

describe("notifications centre", () => {
  it("read, read-all and preferences suppress future notifications", async () => {
    const { call } = await setup();
    await call("POST", "/v1/comments", { user: A, body: { subjectType: "invoice", subjectId: "i1", body: `@${R} one` } });
    await call("POST", "/v1/comments", { user: A, body: { subjectType: "invoice", subjectId: "i1", body: `@${R} two` } });
    const list = await call("GET", "/v1/notifications?unread=true", { user: R });
    expect(list.json.items).toHaveLength(2);
    expect((await call("POST", `/v1/notifications/${list.json.items[0].id}/read`, { user: R })).status).toBe(200);
    expect((await call("POST", `/v1/notifications/${list.json.items[0].id}/read`, { user: ACC })).status).toBe(404);
    expect((await call("POST", "/v1/notifications/read-all", { user: R })).json.updated).toBe(1);
    expect((await call("GET", "/v1/notifications/preferences", { user: R })).json.mention).toBe(true);
    expect((await call("PUT", "/v1/notifications/preferences", { user: R, body: { mention: false } })).json.mention).toBe(false);
    await call("POST", "/v1/comments", { user: A, body: { subjectType: "invoice", subjectId: "i1", body: `@${R} three` } });
    expect((await call("GET", "/v1/notifications?unread=true", { user: R })).json.items).toHaveLength(0);
  });
});

describe("period close (four-eyes)", () => {
  it("request → accountant approves → transactions in period are locked → reopen unlocks", async () => {
    const { call, raw, tA } = await setup();
    await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    const txn = (raw.prepare("select id from transactions where tenant_id = ? limit 1").get(tA) as { id: string }).id;
    const req = await call("POST", "/v1/periods/closes", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-07-31", note: "July books" } });
    expect(req.status).toBe(201);
    expect((await call("GET", "/v1/notifications", { user: ACC })).json.items[0].kind).toBe("close_requested");
    expect((await call("POST", "/v1/periods/closes", { user: A, body: { periodStart: "2026-07-15", periodEnd: "2026-08-15" } })).status).toBe(409);
    expect((await call("POST", `/v1/periods/closes/${req.json.id}/decision`, { user: A, body: { decision: "approve" } })).status).toBe(403); // requester
    expect((await call("POST", `/v1/periods/closes/${req.json.id}/decision`, { user: R, body: { decision: "approve" } })).status).toBe(403); // reviewer
    const ok = await call("POST", `/v1/periods/closes/${req.json.id}/decision`, { user: ACC, body: { decision: "approve", note: "Reconciled" } });
    expect(ok.json).toMatchObject({ status: "approved", decided_by: ACC });
    expect((await call("GET", "/v1/notifications", { user: A })).json.items[0].kind).toBe("close_decided");
    const patch = () => call("PATCH", `/v1/transactions/${txn}`, { user: A, body: { categoryCode: "6200", vatRateCode: null, vatPence: 0 } });
    expect((await patch()).status).toBe(409);
    expect((await call("POST", `/v1/periods/closes/${req.json.id}/decision`, { user: ACC, body: { decision: "approve" } })).status).toBe(409);
    expect((await call("POST", `/v1/periods/closes/${req.json.id}/decision`, { user: A, body: { decision: "reopen" } })).json.status).toBe("reopened");
    expect((await patch()).status).toBe(200);
    expect((await call("GET", "/v1/periods/closes", { user: B })).json).toEqual([]);
    expect((await call("POST", "/v1/periods/closes", { user: A, body: { periodStart: "2026-08-02", periodEnd: "2026-08-01" } })).status).toBe(400);
    expect((await call("POST", `/v1/periods/closes/nope/decision`, { user: ACC, body: { decision: "reject" } })).status).toBe(404);
  });
});

describe("privacy", () => {
  it("DSAR returns subject data; erasure removes/pseudonymises and reports retained records; owners protected", async () => {
    const { call, raw, tA } = await setup();
    await call("POST", "/v1/invoices", {
      user: A,
      body: {
        customerName: "Rita",
        customerEmail: R,
        issueDate: "2026-01-01",
        dueDate: "2026-01-31",
        lines: [{ description: "d", quantity: 1, unitPence: 100, vatRateCode: "STD" }],
      },
    });
    await call("POST", "/v1/comments", { user: R, body: { subjectType: "invoice", subjectId: "i1", body: "note" } });
    await call("POST", "/v1/privacy/consents", { user: A, body: { subject: R, purpose: "product_updates", granted: true } });
    const d = await call("POST", "/v1/privacy/dsar", { user: A, body: { email: R } });
    expect(d.json.data.users).toHaveLength(1);
    expect(d.json.data.invoices).toHaveLength(1);
    expect(d.json.data.comments).toHaveLength(1);
    expect((await call("POST", "/v1/privacy/dsar", { user: R, body: { email: R } })).status).toBe(403);
    expect((await call("POST", "/v1/privacy/erasure", { user: A, body: { email: R } })).status).toBe(400);
    expect((await call("POST", "/v1/privacy/erasure", { user: A, body: { email: A, confirm: true } })).status).toBe(409);
    const e = await call("POST", "/v1/privacy/erasure", { user: A, body: { email: R, confirm: true } });
    expect(e.json.erased.memberships).toBe(1);
    expect(e.json.retained[0]).toMatchObject({ count: 1, reason: "statutory accounting records" });
    expect(raw.prepare("select customer_email from invoices where tenant_id = ?").get(tA)).toEqual({ customer_email: null });
    expect((raw.prepare("select author from comments where tenant_id = ?").get(tA) as { author: string }).author).toMatch(/^erased:/);
    expect((await call("POST", "/v1/privacy/dsar", { user: A, body: { email: R } })).json.data.users).toHaveLength(0);
    expect((await call("GET", "/v1/me", { user: R })).status).toBe(403);
  });
  it("consent log: latest wins, history kept", async () => {
    const { call } = await setup();
    await call("POST", "/v1/privacy/consents", { user: A, body: { subject: "c@example.test", purpose: "marketing_email", granted: true, source: "signup" } });
    await call("POST", "/v1/privacy/consents", { user: A, body: { subject: "c@example.test", purpose: "marketing_email", granted: false } });
    const r = await call("GET", "/v1/privacy/consents?subject=c@example.test", { user: A });
    expect(r.json.current).toEqual([expect.objectContaining({ purpose: "marketing_email", granted: false })]);
    expect(r.json.history).toHaveLength(2);
    expect((await call("GET", "/v1/privacy/consents", { user: B })).json.history).toHaveLength(0);
  });
  it("consent latest-wins is by insertion order even within the same second (was flaky: ordered by random UUID)", async () => {
    const { call, raw } = await setup();
    const body = { subject: "d@example.test", purpose: "marketing_email" };
    await call("POST", "/v1/privacy/consents", { user: A, body: { ...body, granted: true } });
    await call("POST", "/v1/privacy/consents", { user: A, body: { ...body, granted: false } });
    // Same timestamp; give the NEWER row the lexically smaller id, the case that used to pick the wrong "latest".
    raw.prepare("update consents set created_at = '2026-01-01 00:00:00' where subject = ?").run(body.subject);
    raw.prepare("update consents set id = 'zzzz-old' where subject = ? and granted = 1").run(body.subject);
    raw.prepare("update consents set id = '0000-new' where subject = ? and granted = 0").run(body.subject);
    const r = await call("GET", "/v1/privacy/consents?subject=d@example.test", { user: A });
    expect(r.json.current).toEqual([expect.objectContaining({ granted: false })]);
  });
  it("tenant export contains only this tenant's rows; retention policy is unverified", async () => {
    const { call } = await setup();
    await call("POST", "/v1/uploads/bank-csv", { user: B, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    const x = await call("GET", "/v1/privacy/export", { user: A });
    expect(x.json.format).toBe("autopilot-export/v1");
    expect(x.json.tables.transactions).toHaveLength(0);
    expect(x.json.tables.users.length).toBeGreaterThan(0);
    expect((await call("GET", "/v1/privacy/retention", { user: A })).json.verified).toBe(false);
  });
});

describe("multi-business", () => {
  it("lists memberships and switches with x-tenant-id", async () => {
    const { call, tA } = await setup();
    await call("POST", "/v1/users", { user: B, body: { email: ACC, role: "accountant" } });
    const m = await call("GET", "/v1/me/memberships", { user: ACC });
    expect(m.json.map((x: { name: string }) => x.name)).toEqual(["Alpha", "Beta"]);
    const beta = m.json.find((x: { name: string }) => x.name === "Beta").tenantId;
    const sw = await call("GET", "/v1/me/memberships", { user: ACC, headers: { "x-tenant-id": beta } });
    expect(sw.json.find((x: { current: boolean }) => x.current).tenantId).toBe(beta);
    expect((await call("GET", "/v1/me/memberships", { user: A })).json).toEqual([{ tenantId: tA, name: "Alpha", role: "owner", current: true }]);
  });
});
