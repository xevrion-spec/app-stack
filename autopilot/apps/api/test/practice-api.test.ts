/** Practice co-pilot API (M1 firm model + M2 workflow): behaviour, permissions and firm/client isolation. Synthetic data. */
import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";

const P = "partner@firm-a.test",
  M = "manager@firm-a.test",
  PREP = "preparer@firm-a.test",
  REV = "reviewer@firm-a.test",
  RO = "readonly@firm-a.test",
  PB = "partner@firm-b.test";
type H = ReturnType<typeof makeEnv>;
let h: H, call: ReturnType<typeof client>;

async function firm() {
  h = makeEnv();
  call = client(h.env);
  expect((await call("POST", "/v1/practices", { user: P, body: { name: "Firm A (synthetic)" } })).status).toBe(201);
  for (const [email, role] of [
    [M, "manager"],
    [PREP, "preparer"],
    [REV, "reviewer"],
    [RO, "readonly"],
  ] as const)
    expect((await call("POST", "/v1/practice/staff", { user: P, body: { email, role } })).status).toBe(200);
  await call("POST", "/v1/practices", { user: PB, body: { name: "Firm B (synthetic)" } });
}
async function addClient(name: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/practice/clients", { user: M, body: { name, ...extra } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.tenantId as string;
}
async function importAndRun(tid: string, csv = BANK_CSV) {
  const r = await call("POST", `/v1/practice/clients/${tid}/imports/bank-csv`, { user: M, raw: csv, headers: { "content-type": "text/csv" } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await runPipeline(h.env, tid, r.json.jobId);
  return r.json;
}
const assign = (tid: string, list: { email: string; role: string }[]) =>
  call("PUT", `/v1/practice/clients/${tid}/assignments`, { user: M, body: { assignments: list } });

describe("practice + staff", () => {
  beforeEach(firm);
  it("creator is partner; me shows role and quota; non-staff and API keys are refused", async () => {
    const me = await call("GET", "/v1/practice", { user: P });
    expect(me.json).toMatchObject({ role: "partner", staff: 5, clients: 0, quota: { maxClients: 25 } });
    expect((await call("GET", "/v1/practice", { user: "stranger@x.test" })).status).toBe(403);
    expect((await call("GET", "/v1/practice")).status).toBe(401);
  });
  it("only partners manage staff; the last partner cannot be demoted or removed; staff quota", async () => {
    expect((await call("POST", "/v1/practice/staff", { user: M, body: { email: "x@a.test", role: "preparer" } })).status).toBe(403);
    expect((await call("POST", "/v1/practice/staff", { user: P, body: { email: P, role: "manager" } })).status).toBe(409);
    expect((await call("DELETE", `/v1/practice/staff/${encodeURIComponent(P)}`, { user: P })).status).toBe(409);
    expect((await call("POST", "/v1/practice/staff", { user: P, body: { email: "six@a.test", role: "preparer" } })).status).toBe(429);
    expect((await call("DELETE", `/v1/practice/staff/${encodeURIComponent(RO)}`, { user: P })).status).toBe(200);
    expect((await call("DELETE", `/v1/practice/staff/${encodeURIComponent(RO)}`, { user: P })).status).toBe(404);
    const staff = (await call("GET", "/v1/practice/staff", { user: PREP })).json.items.map((s: { email: string }) => s.email);
    expect(staff).not.toContain(RO);
  });
  it("x-practice-id picks between practices; a foreign practice id is refused", async () => {
    const other = (await call("POST", "/v1/practices", { user: P, body: { name: "Second firm" } })).json.id;
    expect((await call("GET", "/v1/practice", { user: P, headers: { "x-practice-id": other } })).json.name).toBe("Second firm");
    const bId = (await call("GET", "/v1/practice", { user: PB })).json.id;
    expect((await call("GET", "/v1/practice", { user: P, headers: { "x-practice-id": bId } })).status).toBe(403);
  });
});

describe("clients, assignment and isolation", () => {
  beforeEach(firm);
  it("managers add clients (VAT stagger required when VAT registered); preparers cannot", async () => {
    expect((await call("POST", "/v1/practice/clients", { user: PREP, body: { name: "No" } })).status).toBe(403);
    expect((await call("POST", "/v1/practice/clients", { user: M, body: { name: "V", vatRegistered: true } })).status).toBe(400);
    const tid = await addClient("Acme Plumbing (synthetic)", { vatRegistered: true, vatStagger: 2, mtdItsa: true, feeModel: "hourly", hourlyRatePence: 6000 });
    const d = await call("GET", `/v1/practice/clients/${tid}?asOf=2026-10-25`, { user: P });
    expect(d.status).toBe(200);
    expect(d.json.settings).toMatchObject({ vatStagger: 2, mtdItsa: true, feeModel: "hourly" });
    expect(d.json.deadlines.some((x: { kind: string }) => x.kind === "vat_return")).toBe(true);
    expect(d.json.deadlines.some((x: { kind: string }) => x.kind === "mtd_quarterly_update")).toBe(true);
    expect(d.json.deadlines.every((x: { verified: boolean }) => x.verified === false)).toBe(true);
  });
  it("client quota per plan (trial = 25), and re-activating an archived client respects it", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await addClient(`C${i}`));
    expect((await call("POST", "/v1/practice/clients", { user: M, body: { name: "26th" } })).status).toBe(429);
    expect((await call("PATCH", `/v1/practice/clients/${ids[0]}`, { user: M, body: { status: "archived" } })).status).toBe(200);
    const extra = await addClient("replacement");
    expect(extra).toBeTruthy();
    expect((await call("PATCH", `/v1/practice/clients/${ids[0]}`, { user: M, body: { status: "active" } })).status).toBe(429);
  });
  it("preparers and reviewers see only assigned clients; partners/managers/readonly see all", async () => {
    const a = await addClient("Assigned Ltd");
    const b = await addClient("Unassigned Ltd");
    expect(
      (
        await assign(a, [
          { email: PREP, role: "preparer" },
          { email: REV, role: "reviewer" },
        ])
      ).status,
    ).toBe(200);
    const names = async (u: string) => (await call("GET", "/v1/practice/clients", { user: u })).json.items.map((x: { name: string }) => x.name).sort();
    expect(await names(PREP)).toEqual(["Assigned Ltd"]);
    expect(await names(REV)).toEqual(["Assigned Ltd"]);
    expect(await names(RO)).toEqual(["Assigned Ltd", "Unassigned Ltd"]);
    expect((await call("GET", `/v1/practice/clients/${b}`, { user: PREP })).status).toBe(404);
    expect(
      (await call("POST", `/v1/practice/clients/${b}/imports/bank-csv`, { user: PREP, raw: BANK_CSV, headers: { "content-type": "text/csv" } })).status,
    ).toBe(404);
  });
  it("assignment rules: staff only, preparers cannot review, readonly cannot be assigned", async () => {
    const a = await addClient("A");
    expect((await assign(a, [{ email: "ghost@x.test", role: "preparer" }])).status).toBe(400);
    expect((await assign(a, [{ email: PREP, role: "reviewer" }])).status).toBe(400);
    expect((await assign(a, [{ email: RO, role: "preparer" }])).status).toBe(400);
    expect((await call("PUT", `/v1/practice/clients/${a}/assignments`, { user: PREP, body: { assignments: [] } })).status).toBe(403);
  });
  it("another firm cannot see, change or bulk-act on this firm's clients", async () => {
    const a = await addClient("Secret Client Ltd");
    await importAndRun(a);
    for (const [m, p] of [
      ["GET", `/v1/practice/clients/${a}`],
      ["PATCH", `/v1/practice/clients/${a}`],
      ["PUT", `/v1/practice/clients/${a}/assignments`],
      ["POST", `/v1/practice/clients/${a}/queries`],
      ["POST", `/v1/practice/clients/${a}/checklists`],
      ["POST", `/v1/practice/clients/${a}/auto-approve`],
    ] as const) {
      const r = await call(m, p, {
        user: PB,
        body: m === "GET" ? undefined : { question: "hello there", assignments: [], templateId: "x", periodEnd: "2026-10-31", dryRun: true },
      });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.text).not.toContain("Secret");
    }
    expect((await call("GET", "/v1/practice/clients", { user: PB })).json.items).toEqual([]);
    expect((await call("GET", "/v1/practice/review-queue", { user: PB })).json.total).toBe(0);
    const bulk = await call("POST", "/v1/practice/bulk", { user: PB, body: { action: "set_status", status: "archived", clientIds: [a] } });
    expect(bulk.json).toMatchObject({ affected: 0, skipped: [{ tenantId: a, reason: "not found" }] });
    const appr = await call("POST", "/v1/practice/review/approve", { user: PB, body: { items: [{ clientId: a, transactionId: "x" }] } });
    expect(appr.status).toBe(404);
  });
  it("practice staff get no access to the client's tenant API, and the client's owner cannot read the practice API", async () => {
    const a = await addClient("A");
    expect((await call("GET", "/v1/transactions", { user: P, headers: { "x-tenant-id": a } })).status).toBe(403);
    expect((await call("GET", "/v1/practice/clients", { user: "owner@business.test" })).status).toBe(403);
  });
  it("read-only staff cannot write anything", async () => {
    const a = await addClient("A");
    for (const [m, p, body] of [
      ["POST", "/v1/practice/time", { clientId: a, minutes: 10, date: "2026-10-01" }],
      ["POST", `/v1/practice/clients/${a}/queries`, { question: "Why?" }],
      ["POST", "/v1/practice/review/approve", { items: [{ clientId: a, transactionId: "t" }] }],
      ["PATCH", "/v1/practice/tasks/x", { status: "done" }],
    ] as const)
      expect((await call(m, p, { user: RO, body })).status, p).toBe(403);
  });
});

describe("review queue, approval, bulk, auto-approve and QA", () => {
  let a: string;
  beforeEach(async () => {
    await firm();
    a = await addClient("Busy Ltd", {
      autoApprove: { threshold: 0.9, categories: ["6300", "6700", "4000", "6100", "6200", "5000", "6600", "6400"] },
      qaSampleRate: 0.5,
    });
    await assign(a, [
      { email: PREP, role: "preparer" },
      { email: REV, role: "reviewer" },
    ]);
    await importAndRun(a);
  });
  const queue = async (u = P, qs = "") => (await call("GET", `/v1/practice/review-queue${qs}`, { user: u })).json;
  it("lists items oldest first with SLA state and auto-approve eligibility", async () => {
    const q = await queue();
    expect(q.total).toBeGreaterThan(5);
    expect(q.items[0]).toMatchObject({ tenantId: a, client: "Busy Ltd", sla: "ok" });
    expect(q.items.some((i: { autoApprovable: boolean }) => i.autoApprovable)).toBe(true);
    expect(q.items.some((i: { autoApprovable: boolean }) => !i.autoApprovable)).toBe(true);
    expect((await queue(PREP, `?clientId=${a}&limit=2`)).items).toHaveLength(2);
    expect((await queue(P, "?sla=breached")).items).toEqual([]);
  });
  it("claim, then filter by assignee; managers may assign to others, preparers may not", async () => {
    const [x, y] = (await queue()).items;
    const cl = await call("POST", "/v1/practice/review/claim", { user: PREP, body: { items: [{ clientId: a, transactionId: x.transactionId }] } });
    expect(cl.json.claimed, JSON.stringify(cl.json)).toBe(1);
    expect(
      (await call("POST", "/v1/practice/review/claim", { user: PREP, body: { assignee: REV, items: [{ clientId: a, transactionId: y.transactionId }] } }))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/v1/practice/review/claim", { user: M, body: { assignee: REV, items: [{ clientId: a, transactionId: y.transactionId }] } })).json
        .claimed,
    ).toBe(1);
    expect((await queue(P, `?assignee=${encodeURIComponent(PREP)}`)).items.map((i: { transactionId: string }) => i.transactionId)).toEqual([x.transactionId]);
    const unclaimed = (await queue(P, "?unclaimed=true")).total;
    expect(unclaimed).toBe((await queue()).total - 2);
    await call("POST", "/v1/practice/review/claim", { user: PREP, body: { release: true, items: [{ clientId: a, transactionId: x.transactionId }] } });
    expect((await queue(P, `?assignee=${encodeURIComponent(PREP)}`)).items).toEqual([]);
  });
  it("approve with and without correction: logs AI vs final, records the correction, emits review.approved, is idempotent", async () => {
    const items = (await queue()).items.filter((i: { categoryCode: string | null }) => i.categoryCode && i.categoryCode !== "9999");
    const [x, y] = items;
    const r = await call("POST", "/v1/practice/review/approve", {
      user: PREP,
      body: {
        items: [
          { clientId: a, transactionId: x.transactionId },
          { clientId: a, transactionId: y.transactionId, categoryCode: y.categoryCode === "6200" ? "6400" : "6200" },
        ],
      },
    });
    expect(r.json).toMatchObject({ approved: 2, corrected: 1, skipped: [] });
    const again = await call("POST", "/v1/practice/review/approve", { user: PREP, body: { items: [{ clientId: a, transactionId: x.transactionId }] } });
    expect(again.json.skipped[0].reason).toBe("already reviewed");
    const log = h.raw.prepare("select ai_category_code, final_category_code, method from review_log order by reviewed_at").all() as {
      ai_category_code: string;
      final_category_code: string;
    }[];
    expect(log).toHaveLength(2);
    expect(log.filter((l) => l.ai_category_code !== l.final_category_code)).toHaveLength(1);
    expect(h.raw.prepare("select count(*) n from category_corrections where tenant_id = ?").get(a)).toEqual({ n: 1 });
    expect(h.raw.prepare("select count(*) n from events where tenant_id = ? and type = 'review.approved'").get(a)).toEqual({ n: 2 });
    expect((await queue()).total).toBe(
      items.length + (await queue()).items.filter((i: { categoryCode: string | null }) => !i.categoryCode || i.categoryCode === "9999").length - 2,
    );
  });
  it("an uncategorised (suspense) item cannot be approved without a category", async () => {
    const s = (await queue()).items.find((i: { categoryCode: string | null }) => !i.categoryCode || i.categoryCode === "9999");
    expect(s).toBeTruthy();
    const r = await call("POST", "/v1/practice/review/approve", { user: PREP, body: { items: [{ clientId: a, transactionId: s.transactionId }] } });
    expect(r.json.skipped[0].reason).toBe("needs a category before approval");
  });
  it("bulk approve: preview + token, stale token refused, preparers refused, confidence floor 0.9", async () => {
    expect((await call("POST", "/v1/practice/review/bulk-approve", { user: PREP, body: {} })).status).toBe(403);
    expect((await call("POST", "/v1/practice/review/bulk-approve", { user: REV, body: { minConfidence: 0.5 } })).status).toBe(400);
    const pre = await call("POST", "/v1/practice/review/bulk-approve", { user: REV, body: { minConfidence: 0.9 } });
    expect(pre.json.executed).toBe(false);
    expect(pre.json.eligible).toBeGreaterThan(0);
    expect((await call("POST", "/v1/practice/review/bulk-approve", { user: REV, body: { minConfidence: 0.9, confirmToken: "bc_nope" } })).status).toBe(409);
    const go = await call("POST", "/v1/practice/review/bulk-approve", { user: REV, body: { minConfidence: 0.9, confirmToken: pre.json.confirmToken } });
    expect(go.json).toMatchObject({ executed: true, approved: pre.json.eligible });
    const replay = await call("POST", "/v1/practice/review/bulk-approve", { user: REV, body: { minConfidence: 0.9, confirmToken: pre.json.confirmToken } });
    expect(replay.status).toBe(409); // the queue changed, so the old token no longer matches
  });
  it("auto-approve: dry run changes nothing; execution approves allowlisted high-confidence items and QA-samples them", async () => {
    const before = (await queue()).total;
    const dry = await call("POST", `/v1/practice/clients/${a}/auto-approve`, { user: M, body: { dryRun: true, seed: "s1" } });
    expect(dry.json.approved).toBeGreaterThan(0);
    expect((await queue()).total).toBe(before);
    expect((await call("POST", `/v1/practice/clients/${a}/auto-approve`, { user: REV, body: { dryRun: false } })).status).toBe(403);
    const run = await call("POST", `/v1/practice/clients/${a}/auto-approve`, { user: M, body: { dryRun: false, seed: "s1" } });
    expect(run.json).toMatchObject({ approved: dry.json.approved, sampledForQa: dry.json.sampledForQa });
    expect((await queue()).total).toBe(before - run.json.approved);
    const qa = await call("GET", "/v1/practice/qa", { user: REV });
    expect(qa.json.items).toHaveLength(run.json.sampledForQa);
    const [first, second] = qa.json.items;
    expect((await call("POST", `/v1/practice/qa/${a}/${first.transactionId}`, { user: REV, body: { result: "pass" } })).status).toBe(200);
    expect((await call("POST", `/v1/practice/qa/${a}/${first.transactionId}`, { user: REV, body: { result: "pass" } })).status).toBe(409);
    if (second) {
      expect((await call("POST", `/v1/practice/qa/${a}/${second.transactionId}`, { user: REV, body: { result: "fail" } })).status).toBe(400);
      const newCat = second.categoryCode === "6200" ? "6400" : "6200";
      expect((await call("POST", `/v1/practice/qa/${a}/${second.transactionId}`, { user: REV, body: { result: "fail", categoryCode: newCat } })).status).toBe(
        200,
      );
      expect(h.raw.prepare("select category_code from transactions where id = ?").get(second.transactionId)).toEqual({ category_code: newCat });
      const stats = (await call("GET", "/v1/practice/qa", { user: REV })).json;
      expect(stats).toMatchObject({ checked: 2, failed: 1, passRate: 0.5 });
    }
    expect((await call("POST", `/v1/practice/qa/${a}/nope`, { user: REV, body: { result: "pass" } })).status).toBe(404);
  });
});

describe("close checklists, queries, tasks", () => {
  let a: string;
  beforeEach(async () => {
    await firm();
    a = await addClient("Close Ltd");
    await assign(a, [{ email: PREP, role: "preparer" }]);
  });
  const monthTpl = async () => (await call("GET", "/v1/practice/close-templates", { user: P })).json.items.find((t: { kind: string }) => t.kind === "month");
  it("checklist lifecycle: unique per period, required items gate completion, preparers cannot complete, locked after", async () => {
    const t = await monthTpl();
    const k = await call("POST", `/v1/practice/clients/${a}/checklists`, { user: PREP, body: { templateId: t.id, periodEnd: "2026-09-30" } });
    expect(k.status).toBe(201);
    expect((await call("POST", `/v1/practice/clients/${a}/checklists`, { user: PREP, body: { templateId: t.id, periodEnd: "2026-09-30" } })).status).toBe(409);
    expect((await call("POST", `/v1/practice/checklists/${k.json.id}/complete`, { user: M, body: {} })).status).toBe(409);
    const d = (await call("GET", `/v1/practice/checklists/${k.json.id}`, { user: PREP })).json;
    expect(d.evidence).toEqual({ awaitingReview: 0, openQueries: 0, openExceptions: 0 });
    for (const it of d.items.filter((i: { required: boolean }) => i.required))
      expect((await call("POST", `/v1/practice/checklists/${k.json.id}/items/${it.idx}`, { user: PREP, body: { done: true, note: "ok" } })).status).toBe(200);
    expect((await call("POST", `/v1/practice/checklists/${k.json.id}/complete`, { user: PREP, body: {} })).status).toBe(403);
    expect((await call("POST", `/v1/practice/checklists/${k.json.id}/complete`, { user: M, body: {} })).status).toBe(200);
    expect((await call("POST", `/v1/practice/checklists/${k.json.id}/items/0`, { user: PREP, body: { done: false } })).status).toBe(409);
    expect((await call("GET", "/v1/practice/checklists?status=complete", { user: P })).json.items[0]).toMatchObject({
      client: "Close Ltd",
      status: "complete",
    });
    expect(h.raw.prepare("select count(*) n from events where tenant_id = ? and type = 'checklist.completed'").get(a)).toEqual({ n: 1 });
    expect((await call("POST", `/v1/practice/checklists/${k.json.id}/items/99`, { user: PREP, body: { done: true } })).status).toBe(409);
  });
  it("completion is blocked while items in the period await review", async () => {
    await importAndRun(a);
    const t = await monthTpl();
    const k = (await call("POST", `/v1/practice/clients/${a}/checklists`, { user: PREP, body: { templateId: t.id, periodEnd: "2026-07-31" } })).json;
    const d = (await call("GET", `/v1/practice/checklists/${k.id}`, { user: PREP })).json;
    expect(d.evidence.awaitingReview).toBeGreaterThan(0);
    for (const it of d.items) await call("POST", `/v1/practice/checklists/${k.id}/items/${it.idx}`, { user: PREP, body: { done: true } });
    const r = await call("POST", `/v1/practice/checklists/${k.id}/complete`, { user: M, body: {} });
    expect(r.status).toBe(409);
    expect(r.json.error.details.awaiting).toBe(d.evidence.awaitingReview);
  });
  it("custom templates and bulk checklist creation across clients with a confirm token", async () => {
    const b = await addClient("Other Ltd");
    const tpl = await call("POST", "/v1/practice/close-templates", {
      user: M,
      body: { name: "Payroll check", kind: "month", items: [{ title: "RTI reviewed" }] },
    });
    expect(tpl.status).toBe(201);
    expect((await call("POST", "/v1/practice/close-templates", { user: PREP, body: { name: "x", kind: "month", items: [{ title: "y" }] } })).status).toBe(403);
    const body = { action: "create_checklist", clientIds: [a, b], templateId: tpl.json.id, periodEnd: "2026-10-31" };
    const pre = await call("POST", "/v1/practice/bulk", { user: M, body });
    expect(pre.json).toMatchObject({ executed: false, affected: 2 });
    expect((await call("POST", "/v1/practice/bulk", { user: PREP, body })).status).toBe(403);
    expect((await call("POST", "/v1/practice/bulk", { user: M, body: { ...body, confirmToken: pre.json.confirmToken } })).json.executed).toBe(true);
    expect((await call("POST", "/v1/practice/bulk", { user: M, body: { ...body, confirmToken: pre.json.confirmToken } })).status).toBe(409);
    expect((await call("GET", "/v1/practice/checklists?status=open", { user: M })).json.items).toHaveLength(2);
  });
  it("bulk set_status and assign", async () => {
    const b = await addClient("B");
    const body = { action: "assign", clientIds: [a, b], assignment: { email: REV, role: "reviewer" } };
    const pre = (await call("POST", "/v1/practice/bulk", { user: P, body })).json;
    await call("POST", "/v1/practice/bulk", { user: P, body: { ...body, confirmToken: pre.confirmToken } });
    expect((await call("GET", "/v1/practice/clients", { user: REV })).json.items).toHaveLength(2);
    const s = { action: "set_status", clientIds: [b], status: "active" };
    const pre2 = (await call("POST", "/v1/practice/bulk", { user: P, body: s })).json;
    await call("POST", "/v1/practice/bulk", { user: P, body: { ...s, confirmToken: pre2.confirmToken } });
    expect((await call("GET", `/v1/practice/clients/${b}`, { user: P })).json.settings.status).toBe("active");
    expect((await call("POST", "/v1/practice/bulk", { user: P, body: { action: "set_status", clientIds: [b] } })).status).toBe(400);
  });
  it("queries: raise about a transaction, list, close; event only (no email)", async () => {
    await importAndRun(a);
    const txn = (await call("GET", `/v1/practice/review-queue?clientId=${a}&limit=1`, { user: PREP })).json.items[0];
    expect((await call("POST", `/v1/practice/clients/${a}/queries`, { user: PREP, body: { question: "What is this?", transactionId: "nope" } })).status).toBe(
      404,
    );
    const q = await call("POST", `/v1/practice/clients/${a}/queries`, {
      user: PREP,
      body: { question: "What was this payment for?", transactionId: txn.transactionId },
    });
    expect(q.status).toBe(201);
    expect((await call("GET", "/v1/practice/queries?status=open", { user: P })).json.items[0]).toMatchObject({
      question: "What was this payment for?",
      client: "Close Ltd",
    });
    expect((await call("GET", "/v1/practice/clients", { user: P })).json.items[0].openQueries).toBe(1);
    expect((await call("POST", `/v1/practice/queries/${q.json.id}/close`, { user: PREP })).status).toBe(200);
    expect((await call("POST", `/v1/practice/queries/${q.json.id}/close`, { user: PREP })).status).toBe(404);
    expect(h.raw.prepare("select count(*) n from events where tenant_id = ? and type = 'query.raised'").get(a)).toEqual({ n: 1 });
  });
  it("recurring tasks: generated once per template/client/month, assigned by default role", async () => {
    await call("PATCH", `/v1/practice/clients/${a}`, { user: M, body: { status: "active", yearEnd: "03-31" } });
    for (const [name, recurrence] of [
      ["Bookkeeping", "monthly"],
      ["VAT prep", "quarterly"],
      ["Year end", "yearly"],
    ] as const)
      await call("POST", "/v1/practice/task-templates", { user: M, body: { name, recurrence, dueDay: 20, defaultRole: "preparer" } });
    expect((await call("GET", "/v1/practice/task-templates", { user: PREP })).json.items).toHaveLength(3);
    const g = await call("POST", "/v1/practice/tasks/generate", { user: M, body: { month: "2027-03" } });
    expect(g.json.created).toBe(3);
    expect((await call("POST", "/v1/practice/tasks/generate", { user: M, body: { month: "2027-03" } })).json.created).toBe(0);
    expect((await call("POST", "/v1/practice/tasks/generate", { user: M, body: { month: "2027-04" } })).json.created).toBe(1);
    const tasks = (await call("GET", `/v1/practice/tasks?assignee=${encodeURIComponent(PREP)}&asOf=2027-03-25`, { user: PREP })).json.items;
    expect(tasks.filter((t: { overdue: boolean }) => t.overdue)).toHaveLength(3);
    expect((await call("PATCH", `/v1/practice/tasks/${tasks[0].id}`, { user: PREP, body: { assignee: REV } })).status).toBe(403);
    expect((await call("PATCH", `/v1/practice/tasks/${tasks[0].id}`, { user: PREP, body: { status: "done" } })).json.status).toBe("done");
    expect((await call("PATCH", "/v1/practice/tasks/nope", { user: PREP, body: { status: "done" } })).status).toBe(404);
  });
});

describe("time, WIP and internal billing records", () => {
  beforeEach(firm);
  it("hourly: time -> WIP -> billing record marks time billed; fixed fee accrues per month; outcome per completed close", async () => {
    const hourly = await addClient("Hourly", { feeModel: "hourly", hourlyRatePence: 6000 });
    const fixed = await addClient("Fixed", { feeModel: "fixed", feePence: 10_000 });
    const outcome = await addClient("Outcome", { feeModel: "outcome", feePence: 25_000 });
    await call("POST", "/v1/practice/time", { user: PREP, body: { clientId: hourly, minutes: 90, date: "2026-10-01" } }).then((r) =>
      expect(r.status).toBe(404),
    ); // not assigned
    await assign(hourly, [{ email: PREP, role: "preparer" }]);
    expect((await call("POST", "/v1/practice/time", { user: PREP, body: { clientId: hourly, minutes: 90, date: "2026-10-01" } })).status).toBe(201);
    await call("POST", "/v1/practice/time", { user: PREP, body: { clientId: hourly, minutes: 30, date: "2026-10-02", billable: false } });
    expect((await call("GET", "/v1/practice/time", { user: PREP })).json.totalMinutes).toBe(120);
    const asOf = new Date(Date.now() + 62 * 86400_000).toISOString().slice(0, 10);
    const wip = (await call("GET", `/v1/practice/billing/wip?asOf=${asOf}`, { user: M })).json;
    const by = (n: string) => wip.items.find((w: { client: string }) => w.client === n);
    expect(by("Hourly").wipPence).toBe(9000);
    expect(by("Fixed").wipPence).toBeGreaterThanOrEqual(20_000);
    expect(by("Outcome")).toMatchObject({ wipPence: 0, billingReady: false });
    expect((await call("GET", "/v1/practice/billing/wip", { user: PREP })).status).toBe(403);
    const rec = await call("POST", "/v1/practice/billing/records", { user: M, body: { clientId: hourly, periodEnd: asOf } });
    expect(rec.json).toMatchObject({ amountPence: 9000, kind: "hourly" });
    expect((await call("POST", "/v1/practice/billing/records", { user: M, body: { clientId: hourly, periodEnd: asOf } })).status).toBe(409);
    expect((await call("POST", "/v1/practice/billing/records", { user: M, body: { clientId: outcome, periodEnd: asOf } })).status).toBe(409);
    expect((await call("GET", "/v1/practice/time", { user: M })).json.items.find((t: { minutes: number }) => t.minutes === 90).billed).toBe(true);
    expect((await call("GET", "/v1/practice/billing/records", { user: M })).json.items).toHaveLength(1);
    expect((await call("GET", `/v1/practice/billing/records?clientId=${fixed}`, { user: M })).json.items).toHaveLength(0);
  });
});

describe("dashboard and deadlines", () => {
  beforeEach(firm);
  it("aggregates health, backlog by age, workload, deadlines and risk across visible clients", async () => {
    const a = await addClient("Dash A", { vatRegistered: true, vatStagger: 1 });
    await addClient("Dash B");
    await assign(a, [{ email: PREP, role: "preparer" }]);
    await importAndRun(a);
    h.raw.prepare("update transactions set created_at = '2026-09-01 09:00:00' where tenant_id = ?").run(a);
    const d = (await call("GET", "/v1/practice/dashboard?asOf=2026-10-25", { user: P })).json;
    expect(d.clients.total).toBe(2);
    expect(d.review.awaiting).toBeGreaterThan(0);
    expect(d.review.byAge["15d+"]).toBe(d.review.awaiting);
    expect(d.review.slaBreached).toBe(d.review.awaiting);
    expect(d.riskFlags.some((f: { flag: string }) => f.flag.includes("review backlog"))).toBe(true);
    expect(d.workload.find((w: { email: string }) => w.email === PREP)).toMatchObject({ clients: 1, awaiting: d.review.awaiting });
    const mine = (await call("GET", "/v1/practice/dashboard?asOf=2026-10-25", { user: PREP })).json;
    expect(mine.clients.total).toBe(1);
    const dl = (await call("GET", "/v1/practice/deadlines?asOf=2026-10-25&days=30", { user: P })).json;
    expect(dl.verified).toBe(false);
    expect(dl.items.some((x: { kind: string; client: string }) => x.kind === "vat_return" && x.client === "Dash A")).toBe(true);
    expect(dl.items.every((x: { daysLeft: number }, i: number, arr: { daysLeft: number }[]) => i === 0 || arr[i - 1]!.daysLeft <= x.daysLeft)).toBe(true);
  });
});
