/**
 * Endpoint matrix: auth, membership, roles, validation, tenant isolation, idempotency, pagination, audit log and security
 * inputs, for every /v1 route. Real SQLite + real migrations via the harness.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";

const A = "owner-a@example.test", B = "owner-b@example.test", R = "reviewer-a@example.test", NOBODY = "nobody@example.test";
type Call = ReturnType<typeof client>;
const csvH = { "content-type": "text/csv" };
const inv = { customerName: "Acme Ltd", issueDate: "2026-07-01", dueDate: "2026-07-31", lines: [{ description: "Design", quantity: 1, unitPence: 10000, vatRateCode: "STD" }] };

async function world() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: csvH });
  const m = h.sent.at(-1)!;
  await runPipeline(h.env, m.tenantId, m.jobId, undefined);
  const txns = (await call("GET", "/v1/transactions?limit=200", { user: A })).json.items as { id: string; description: string }[];
  const invoice = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
  const ex = (await call("GET", "/v1/exceptions?limit=200", { user: A })).json.items as { id: string }[];
  const job = (await call("GET", "/v1/jobs", { user: A })).json.items[0];
  return { ...h, call, txnId: txns[0]!.id, invoiceId: invoice.id as string, exId: ex[0]!.id, jobId: job.id as string, txns };
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/v1/me"], ["GET", "/v1/tenant"], ["PATCH", "/v1/tenant", { name: "X" }], ["GET", "/v1/users"], ["POST", "/v1/users", { email: "z@x.test", role: "reviewer" }],
  ["POST", "/v1/uploads/bank-csv"], ["POST", "/v1/uploads/receipt"], ["GET", "/v1/transactions"], ["PATCH", "/v1/transactions/ID", { categoryCode: "6200" }],
  ["GET", "/v1/categories"], ["POST", "/v1/categories", { code: "6900", name: "Misc", kind: "expense" }], ["GET", "/v1/rules"], ["POST", "/v1/rules", { pattern: "ACME", categoryCode: "6200" }],
  ["GET", "/v1/ledger/trial-balance"], ["GET", "/v1/ledger/journals"], ["GET", "/v1/invoices"], ["POST", "/v1/invoices", inv], ["POST", "/v1/invoices/ID/status", { status: "sent" }],
  ["GET", "/v1/invoices/ID/pdf"], ["POST", "/v1/vat/drafts", { periodStart: "2026-07-01", periodEnd: "2026-09-30" }], ["GET", "/v1/vat/drafts"], ["GET", "/v1/sa/summary"],
  ["GET", "/v1/exceptions"], ["POST", "/v1/exceptions/ID/resolve", { decision: "approve" }], ["GET", "/v1/jobs"], ["GET", "/v1/jobs/ID"], ["POST", "/v1/jobs/ID/rerun"],
  ["GET", "/v1/billing/events"], ["GET", "/v1/export/transactions.csv"], ["GET", "/v1/export/ledger.json"],
];

describe("every route requires authentication", () => {
  let call: Call;
  beforeAll(() => { call = client(makeEnv().env); });
  it.each(ROUTES)("%s %s -> 401", async (m, p, body) => {
    const r = await call(m, p.replace("ID", "x"), body ? { body } : {});
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthenticated");
  });
});

describe("authenticated user without membership", () => {
  let call: Call;
  beforeAll(() => { call = client(makeEnv().env); });
  it.each(ROUTES)("%s %s -> 403 no_membership", async (m, p, body) => {
    const r = await call(m, p.replace("ID", "x"), { user: NOBODY, ...(body ? { body } : {}) });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("no_membership");
  });
});

describe("roles", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  const fill = (p: string) => p.replace("/transactions/ID", `/transactions/${w.txnId}`).replace("/invoices/ID", `/invoices/${w.invoiceId}`).replace("/exceptions/ID", `/exceptions/${w.exId}`).replace("/jobs/ID", `/jobs/${w.jobId}`);
  const OWNER_ONLY: [string, string, unknown?][] = [
    ["PATCH", "/v1/tenant", { name: "Hacked" }], ["GET", "/v1/users"], ["POST", "/v1/users", { email: "evil@x.test", role: "owner" }], ["POST", "/v1/uploads/bank-csv"],
    ["POST", "/v1/uploads/receipt"], ["POST", "/v1/categories", { code: "6901", name: "X", kind: "expense" }], ["POST", "/v1/invoices", inv], ["POST", "/v1/invoices/ID/status", { status: "void" }],
    ["GET", "/v1/invoices/ID/pdf"],
  ];
  it.each(OWNER_ONLY)("reviewer cannot %s %s", async (m, p, body) => {
    const r = await w.call(m, fill(p), { user: R, ...(body ? { body } : {}) });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
  });
  const REVIEWER_OK: [string, string][] = [["GET", "/v1/me"], ["GET", "/v1/tenant"], ["GET", "/v1/transactions"], ["GET", "/v1/categories"], ["GET", "/v1/rules"], ["GET", "/v1/ledger/trial-balance"], ["GET", "/v1/ledger/journals"], ["GET", "/v1/invoices"], ["GET", "/v1/vat/drafts"], ["GET", "/v1/sa/summary"], ["GET", "/v1/exceptions"], ["GET", "/v1/jobs"], ["GET", "/v1/jobs/ID"], ["GET", "/v1/export/ledger.json"]];
  it.each(REVIEWER_OK)("reviewer can %s %s", async (m, p) => expect((await w.call(m, fill(p), { user: R })).status).toBe(200));
  it("reviewer sees role=reviewer on /me", async () => expect((await w.call("GET", "/v1/me", { user: R })).json.role).toBe("reviewer"));
  it("reviewer can categorise a transaction", async () => expect((await w.call("PATCH", `/v1/transactions/${w.txnId}`, { user: R, body: { categoryCode: "6200" } })).status).toBe(200));
});

describe("tenant isolation (B attacks A's resources)", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  it.each([
    ["PATCH", "txn", { categoryCode: "6200" }], ["POST", "invoice-status", { status: "void" }], ["GET", "invoice-pdf"], ["POST", "exception", { decision: "approve" }], ["GET", "job"], ["POST", "rerun"],
  ] as [string, "txn" | "invoice-status" | "invoice-pdf" | "exception" | "job" | "rerun", unknown?][])("%s %s -> 404 and A's data unchanged", async (m, what, body) => {
    const path = { txn: `/v1/transactions/${w.txnId}`, "invoice-status": `/v1/invoices/${w.invoiceId}/status`, "invoice-pdf": `/v1/invoices/${w.invoiceId}/pdf`, exception: `/v1/exceptions/${w.exId}/resolve`, job: `/v1/jobs/${w.jobId}`, rerun: `/v1/jobs/${w.jobId}/rerun` }[what];
    const r = await w.call(m, path, { user: B, ...(body ? { body } : {}) });
    expect(r.status).toBe(404);
    const inv2 = (await w.call("GET", "/v1/invoices", { user: A })).json.find((i: { id: string }) => i.id === w.invoiceId);
    expect(inv2.status).not.toBe("void");
  });
  it.each(["/v1/transactions", "/v1/invoices", "/v1/exceptions", "/v1/jobs", "/v1/ledger/journals", "/v1/vat/drafts", "/v1/billing/events", "/v1/export/transactions.csv", "/v1/export/ledger.json", "/v1/users", "/v1/rules"])(
    "B's %s never contains A's rows", async (p) => {
      const r = await w.call("GET", p, { user: B });
      expect(r.status).toBe(200);
      for (const t of w.txns) expect(r.text).not.toContain(t.id);
      expect(r.text).not.toContain(w.invoiceId);
      expect(r.text).not.toContain(R);
    });
  it.each(["tenant-of-a", "' or 1=1 --", ""])("x-tenant-id %j for a non-member tenant is refused", async (tid) => {
    const target = tid === "tenant-of-a" ? (await w.call("GET", "/v1/me", { user: A })).json.tenantId : tid;
    const r = await w.call("GET", "/v1/transactions", { user: B, headers: { "x-tenant-id": target } });
    if (tid === "") expect(r.status).toBe(200); // empty header = default membership
    else expect(r.status).toBe(403);
  });
  it("a rule created by B never categorises A's lines", async () => {
    await w.call("POST", "/v1/rules", { user: B, body: { pattern: "MYSTERY PAYEE", categoryCode: "6600", priority: 0 } });
    const t = w.txns.find((x) => x.description.includes("MYSTERY"))!;
    const a = (await w.call("GET", "/v1/transactions?limit=200", { user: A })).json.items.find((x: { id: string }) => x.id === t.id);
    expect(a.category_code).not.toBe("6600");
  });
});

describe("validation", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  it.each([
    ["POST", "/v1/tenants", { name: "" }], ["POST", "/v1/tenants", { name: "x".repeat(121) }], ["POST", "/v1/tenants", { name: "X", vatScheme: "made_up" }],
    ["POST", "/v1/tenants", { name: "X", flatRatePercent: 0 }], ["POST", "/v1/tenants", { name: "X", flatRatePercent: 100 }], ["PATCH", "/v1/tenant", { vatRegistered: "yes" }],
    ["POST", "/v1/users", { email: "not-an-email", role: "reviewer" }], ["POST", "/v1/users", { email: "a@b.test", role: "admin" }], ["POST", "/v1/users", { email: "a@b.test", role: "reviewer", displayName: "x".repeat(81) }],
    ["PATCH", "/v1/transactions/TXN", {}], ["PATCH", "/v1/transactions/TXN", { categoryCode: "" }], ["PATCH", "/v1/transactions/TXN", { categoryCode: "6200", vatRateCode: "HIGH" }],
    ["PATCH", "/v1/transactions/TXN", { categoryCode: "6200", vatPence: -1 }], ["PATCH", "/v1/transactions/TXN", { categoryCode: "6200", vatPence: 1.5 }],
    ["POST", "/v1/categories", { code: "12", name: "X", kind: "expense" }], ["POST", "/v1/categories", { code: "abcd", name: "X", kind: "expense" }], ["POST", "/v1/categories", { code: "6902", name: "X", kind: "weird" }],
    ["POST", "/v1/rules", { pattern: "A", categoryCode: "6200" }], ["POST", "/v1/rules", { pattern: "ACME", categoryCode: "6200", matchType: "glob" }], ["POST", "/v1/rules", { pattern: "ACME", categoryCode: "6200", priority: 1001 }],
    ["POST", "/v1/invoices", { ...inv, lines: [] }], ["POST", "/v1/invoices", { ...inv, issueDate: "01/07/2026" }], ["POST", "/v1/invoices", { ...inv, customerName: "" }],
    ["POST", "/v1/invoices", { ...inv, customerEmail: "nope" }], ["POST", "/v1/invoices", { ...inv, lines: [{ ...inv.lines[0], quantity: 0 }] }], ["POST", "/v1/invoices", { ...inv, lines: [{ ...inv.lines[0], unitPence: -1 }] }],
    ["POST", "/v1/invoices", { ...inv, lines: Array(101).fill(inv.lines[0]) }, "101 lines"], ["POST", "/v1/invoices/INV/status", { status: "draft" }],
    ["POST", "/v1/vat/drafts", { periodStart: "2026-07-01" }], ["POST", "/v1/vat/drafts", { periodStart: "July", periodEnd: "2026-09-30" }], ["POST", "/v1/vat/drafts", { periodStart: "2026-07-01", periodEnd: "2026-09-30", scheme: "annual" }],
    ["POST", "/v1/exceptions/EX/resolve", { decision: "explode" }], ["GET", "/v1/transactions?limit=0"], ["GET", "/v1/transactions?limit=201"], ["GET", "/v1/transactions?limit=abc"],
    ["GET", "/v1/jobs?limit=-5"], ["GET", "/v1/sa/summary?taxYearStart=2026"],
  ] as [string, string, unknown?, string?][])("%s %s -> 400 (case %#)", async (m, p, body) => {
    const r = await w.call(m, p.replace("TXN", w.txnId).replace("INV", w.invoiceId).replace("EX", w.exId), { user: A, ...(body !== undefined ? { body } : {}) });
    expect(r.status).toBe(400);
    expect(["validation_failed", "bad_request"]).toContain(r.json.error.code);
    expect(r.json.error.requestId).toBeTruthy();
  });
  it.each([["not json", "{nope"], ["array", "[]"], ["null", "null"]])("malformed JSON body (%s) -> 400", async (_n, raw) => {
    const r = await w.call("POST", "/v1/invoices", { user: A, raw, headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
  });
  it.each(["/v1/transactions/nope", "/v1/invoices/nope/status", "/v1/exceptions/nope/resolve", "/v1/jobs/nope"])("unknown id on %s -> 404", async (p) => {
    const m = p.endsWith("/nope") && !p.includes("transactions") ? "GET" : p.includes("transactions") ? "PATCH" : "POST";
    const body = p.includes("transactions") ? { categoryCode: "6200" } : p.includes("status") ? { status: "sent" } : p.includes("resolve") ? { decision: "approve" } : undefined;
    expect((await w.call(m, p, { user: A, ...(body ? { body } : {}) })).status).toBe(404);
  });
  it("categorising to a category that does not exist is rejected", async () => {
    const r = await w.call("PATCH", `/v1/transactions/${w.txnId}`, { user: A, body: { categoryCode: "0000" } });
    expect([400, 404]).toContain(r.status);
  });
  it("unknown route -> 404 typed error", async () => {
    const r = await w.call("GET", "/v1/definitely-not-here", { user: A });
    expect(r.status).toBe(404);
  });
});

describe("uploads: limits, content types, checksums, duplicates", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  it.each(["application/json", "image/png", "text/html", "application/octet-stream"])("bank csv with content-type %j -> 415", async (ct) => {
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: ct ? { "content-type": ct } : {} });
    expect(r.status).toBe(415);
  });
  it.each(["text/csv", "text/plain", "application/csv", "text/csv; charset=utf-8"])("accepts %s", async (ct) => {
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: `Date,Description,Amount\n01/01/2026,CT ${ct},1.00`, headers: { "content-type": ct } });
    expect(r.status).toBe(201);
  });
  it("rejects > 2 MB with 413", async () => {
    const big = "Date,Description,Amount\n" + "01/07/2026,X,1.00\n".repeat(130_000);
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: big, headers: csvH });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
  });
  it("returns the SHA-256 of the exact bytes and stores the object under the tenant prefix", async () => {
    const body = "Date,Description,Amount\n02/02/2026,CHECKSUM TEST,1.00";
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: body, headers: csvH });
    const { sha256Hex } = await import("../src/services/csv.js");
    expect(r.json.sha256).toBe(await sha256Hex(body));
    const me = (await w.call("GET", "/v1/me", { user: A })).json;
    expect([...w.objects.keys()].some((k) => k.startsWith(`${me.tenantId}/statements/${r.json.documentId}`))).toBe(true);
  });
  it("re-uploading the same statement inserts nothing and does not queue a job", async () => {
    const before = w.sent.length;
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: csvH });
    expect(r.json).toMatchObject({ inserted: 0, duplicates: 11 });
    expect(w.sent.length).toBe(before);
  });
  it("overlapping statement only inserts new lines", async () => {
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV.trim() + "\n31/07/2026,NEW LINE ONLY,-1.00\n", headers: csvH });
    expect(r.json).toMatchObject({ inserted: 1, duplicates: 11 });
  });
  it("the same line in another tenant is not a duplicate", async () => {
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: B, raw: BANK_CSV, headers: csvH });
    expect(r.json.inserted).toBe(11);
  });
  it("reports rejected rows with row numbers", async () => {
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: "Date,Description,Amount\n03/03/2026,OK,1\n31/02/2026,BAD,1", headers: csvH });
    expect(r.json.rejectedRows).toEqual([{ row: 3, error: expect.stringMatching(/invalid date/) }]);
  });
  it.each([["header only", "Date,Description,Amount"], ["no columns", "foo,bar\n1,2"], ["unterminated", 'Date,Description,Amount\n01/01/2026,"x,1']])("bad CSV (%s) -> 400", async (_n, raw) =>
    expect((await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw, headers: csvH })).status).toBe(400));
});

describe("idempotency", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  it("same key + same body replays the first response and creates one invoice", async () => {
    const h = { "idempotency-key": "k-inv-1" };
    const a = await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: h });
    const b = await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: h });
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    const n = (await w.call("GET", "/v1/invoices", { user: A })).json.filter((i: { id: string }) => i.id === a.json.id).length;
    expect(n).toBe(1);
  });
  it("same key + different body -> 409 (not a silent replay)", async () => {
    const h = { "idempotency-key": "k-inv-2" };
    await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: h });
    const r = await w.call("POST", "/v1/invoices", { user: A, body: { ...inv, customerName: "Other" }, headers: h });
    expect(r.status).toBe(409);
  });
  it("same key on another route -> 409", async () => {
    await w.call("POST", "/v1/rules", { user: A, body: { pattern: "IDEMP", categoryCode: "6200" }, headers: { "idempotency-key": "k-x" } });
    expect((await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: { "idempotency-key": "k-x" } })).status).toBe(409);
  });
  it("keys are tenant-scoped: B can use A's key", async () => {
    const r = await w.call("POST", "/v1/invoices", { user: B, body: inv, headers: { "idempotency-key": "k-inv-1" } });
    expect(r.status).toBe(201);
    expect(r.headers.get("idempotent-replay")).toBeNull();
  });
  it("failed requests are not cached", async () => {
    const h = { "idempotency-key": "k-fail" };
    expect((await w.call("POST", "/v1/invoices", { user: A, body: { ...inv, lines: [] }, headers: h })).status).toBe(400);
    expect((await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: h })).status).toBe(201);
  });
  it("over-long key -> 400", async () => expect((await w.call("POST", "/v1/invoices", { user: A, body: inv, headers: { "idempotency-key": "k".repeat(129) } })).status).toBe(400));
  it("invoice numbers stay unique and sequential under repeated creates", async () => {
    const nums = [];
    for (let i = 0; i < 5; i++) nums.push((await w.call("POST", "/v1/invoices", { user: A, body: inv })).json.number);
    expect(new Set(nums).size).toBe(5);
    expect([...nums].sort()).toEqual(nums);
  });
});

describe("pagination", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  it.each([1, 2, 3, 5, 11, 50])("limit=%i walks all transactions exactly once", async (limit) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const r = await w.call("GET", `/v1/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { user: A });
      expect(r.json.items.length).toBeLessThanOrEqual(limit);
      seen.push(...r.json.items.map((x: { id: string }) => x.id));
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(11);
    expect(new Set(seen).size).toBe(11);
  });
  it.each(["garbage", "' or 1=1 --", "eyJ4IjoxfQ", "%00"])("bad cursor %j is handled safely", async (c) => {
    const r = await w.call("GET", `/v1/transactions?cursor=${encodeURIComponent(c)}`, { user: A });
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(r.json.items.length).toBeLessThanOrEqual(11);
  });
  it.each(["/v1/jobs", "/v1/exceptions", "/v1/ledger/journals"])("%s pages with nextCursor", async (p) => {
    const r = await w.call("GET", `${p}?limit=1`, { user: A });
    expect(r.json.items.length).toBeLessThanOrEqual(1);
    expect("nextCursor" in r.json).toBe(true);
  });
});

describe("audit log", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  const audit = (action: string) => w.raw.prepare("select actor, subject from audit_log where action = ?").all(action) as { actor: string; subject: string }[];
  it.each([
    ["tenant.created", async () => {}],
    ["upload.bank_csv", async () => {}],
    ["invoice.created", async () => {}],
    ["user.created", async () => {}],
    ["export.transactions_csv", async () => { await w.call("GET", "/v1/export/transactions.csv", { user: A }); }],
    ["transaction.categorised", async () => { await w.call("PATCH", `/v1/transactions/${w.txnId}`, { user: R, body: { categoryCode: "6200" } }); }],
  ] as [string, () => Promise<void>][])("%s is audited with the actor", async (action, act) => {
    await act();
    const rows = audit(action);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor)).toBe(true);
  });
  it("audit rows are tenant-scoped", () => {
    const t = w.raw.prepare("select count(distinct tenant_id) n from audit_log where action = 'tenant.created'").get() as { n: number };
    expect(t.n).toBe(2);
  });
});

describe("security inputs", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  const NASTY = ["'; drop table transactions; --", "\" or \"1\"=\"1", "1; delete from users", "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)", "=HYPERLINK(\"http://evil\",\"x\")", "+SUM(1+1)", "-2+3", "@cmd", "\u0000null", "😀 émoji ü", "../../etc/passwd", "${7*7}", "{{7*7}}"];
  it.each(NASTY)("description %j is stored verbatim, data intact", async (s) => {
    const desc = s.replace(/"/g, "'").replace(/,/g, " ");
    const r = await w.call("POST", "/v1/uploads/bank-csv", { user: A, raw: `Date,Description,Amount\n09/09/2026,"${desc}",-1.23`, headers: csvH });
    expect(r.status).toBe(201);
    const list = (await w.call("GET", "/v1/transactions?limit=200", { user: A })).json.items as { description: string }[];
    expect(list.some((t) => t.description === desc.trim())).toBe(true);
    expect((w.raw.prepare("select count(*) n from users").get() as { n: number }).n).toBeGreaterThanOrEqual(3);
  });
  it.each(NASTY)("customer name %j round-trips through JSON as data", async (s) => {
    const r = await w.call("POST", "/v1/invoices", { user: A, body: { ...inv, customerName: s.slice(0, 120) || "x" } });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.json.customer_name).toBe(s.slice(0, 120) || "x");
  });
  it("CSV export neutralises formula cells but keeps negative numbers numeric", async () => {
    const r = await w.call("GET", "/v1/export/transactions.csv", { user: A });
    const lines = r.text.split("\n");
    for (const l of lines.slice(1)) expect(l).not.toMatch(/(^|,)"?[=+@]/);
    expect(r.text).toContain(",-4560,");
    expect(r.text).toMatch(/'=HYPERLINK/);
  });
  it("PDF renders safely with hostile customer names", async () => {
    const i = (await w.call("POST", "/v1/invoices", { user: A, body: { ...inv, customerName: "<script>😀\u0000" } })).json;
    const r = await w.call("GET", `/v1/invoices/${i.id}/pdf`, { user: A });
    expect(r.status).toBe(200);
    expect(r.text.startsWith("%PDF")).toBe(true);
  });
  it("oversized JSON body is rejected", async () => {
    const r = await w.call("POST", "/v1/invoices", { user: A, body: { ...inv, lines: [{ ...inv.lines[0], description: "x".repeat(2_000_000) }] } });
    expect([400, 413]).toContain(r.status);
  });
  it.each(["(a+)+$", "(.*a){20}", "([a-z]+)*X"])("catastrophic regex rule %j is refused or bounded", async (pattern) => {
    const r = await w.call("POST", "/v1/rules", { user: A, body: { pattern, matchType: "regex", categoryCode: "6200" } });
    expect(r.status).toBe(400);
  });
  it("security headers on every response", async () => {
    const r = await w.call("GET", "/v1/me", { user: A });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBeTruthy();
  });
  it.each(["http://evil.test", "null"])("CORS does not reflect untrusted origin %s", async (o) => {
    const r = await w.call("GET", "/v1/me", { user: A, headers: { origin: o } });
    expect(r.headers.get("access-control-allow-origin")).not.toBe(o);
  });
  it("CORS allows the configured origin", async () => {
    const r = await w.call("GET", "/v1/me", { user: A, headers: { origin: "http://localhost:5173" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
  it("errors never leak stack traces", async () => {
    const r = await w.call("POST", "/v1/invoices", { user: A, raw: "{", headers: { "content-type": "application/json" } });
    expect(r.text).not.toMatch(/at .*\.ts:\d+/);
  });
});
