/** Practice co-pilot M4: learning with provenance, anomalies, accuracy harness, drift, assistant (scoped, cited). Synthetic. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { setLlmRouter } from "../src/routes/practice-intel.js";
import { mockLlmRouter } from "../src/services/llm-router.js";

const P = "partner@firm-a.test",
  M = "manager@firm-a.test",
  PREP = "preparer@firm-a.test",
  REV = "reviewer@firm-a.test",
  PB = "partner@firm-b.test";
const ANOM_CSV = `Date,Description,Amount
04/07/2026,ACME TOOLS 001,-120.00
05/07/2026,ACME TOOLS 002,-120.00
06/07/2026,BIG LAPTOP PURCHASE,-1000.00
07/07/2026,CLIENT RECEIPT,300.00
`;
let h: ReturnType<typeof makeEnv>, call: ReturnType<typeof client>, a: string, b: string, other: string;
async function imp(tid: string, csv: string, user = M) {
  const r = await call("POST", `/v1/practice/clients/${tid}/imports/bank-csv`, { user, raw: csv, headers: { "content-type": "text/csv" } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await runPipeline(h.env, tid, r.json.jobId);
}
const queue = async (tid: string) =>
  (await call("GET", `/v1/practice/review-queue?clientId=${tid}&limit=500`, { user: M })).json.items as {
    transactionId: string;
    description: string;
    categoryCode: string | null;
  }[];
beforeEach(async () => {
  h = makeEnv();
  call = client(h.env);
  await call("POST", "/v1/practices", { user: P, body: { name: "Firm A" } });
  for (const [email, role] of [
    [M, "manager"],
    [PREP, "preparer"],
    [REV, "reviewer"],
  ] as const)
    await call("POST", "/v1/practice/staff", { user: P, body: { email, role } });
  await call("POST", "/v1/practices", { user: PB, body: { name: "Firm B" } });
  a = (await call("POST", "/v1/practice/clients", { user: M, body: { name: "Alpha Ltd", vatRegistered: true, vatStagger: 1 } })).json.tenantId;
  b = (await call("POST", "/v1/practice/clients", { user: M, body: { name: "Beta Ltd" } })).json.tenantId;
  other = (await call("POST", "/v1/practice/clients", { user: PB, body: { name: "Gamma (Firm B)" } })).json.tenantId;
  for (const t of [a, b]) await call("PATCH", `/v1/practice/clients/${t}`, { user: M, body: { status: "active" } });
});
afterEach(() => setLlmRouter(mockLlmRouter));

describe("learning from corrections", () => {
  it("a correction in two clients becomes a firm rule with provenance; one client gives a client rule; disable/enable", async () => {
    await imp(a, BANK_CSV);
    await imp(b, BANK_CSV);
    const fix = async (tid: string, desc: string, code: string) => {
      const items = (await queue(tid)).filter((x) => x.description?.includes(desc));
      expect(items.length).toBeGreaterThan(0);
      const r = await call("POST", "/v1/practice/review/approve", {
        user: M,
        body: { items: items.map((i) => ({ clientId: tid, transactionId: i.transactionId, categoryCode: code })) },
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    await fix(a, "MYSTERY PAYEE", "6700");
    await fix(b, "MYSTERY PAYEE", "6700");
    // learnRules needs 2 pieces of evidence per client: add a second correction per client
    await imp(a, "Date,Description,Amount\n02/08/2026,MYSTERY PAYEE 77,-81.00\n");
    await imp(b, "Date,Description,Amount\n02/08/2026,MYSTERY PAYEE 66,-82.00\n");
    await fix(a, "MYSTERY PAYEE 77", "6700");
    await fix(b, "MYSTERY PAYEE 66", "6700");
    await imp(a, "Date,Description,Amount\n03/08/2026,ONLY ALPHA VENDOR,-10.00\n04/08/2026,ONLY ALPHA VENDOR,-11.00\n");
    await fix(a, "ONLY ALPHA VENDOR", "6600");
    expect((await call("POST", "/v1/practice/learning/derive", { user: PREP })).status).toBe(403);
    const d = await call("POST", "/v1/practice/learning/derive", { user: M });
    expect(d.json).toMatchObject({ practiceRules: 1, clientRules: 1 });
    expect(d.json.corrections).toBeGreaterThanOrEqual(6);
    const again = await call("POST", "/v1/practice/learning/derive", { user: M });
    expect(again.json).toMatchObject({ created: 0, updated: 2 });
    const rules = (await call("GET", "/v1/practice/rules", { user: M })).json.items;
    const firm = rules.find((r: { scope: string }) => r.scope === "practice");
    expect(firm).toMatchObject({ pattern: "MYSTERY PAYEE", categoryCode: "6700", clients: 2, tenantId: null });
    expect(firm.provenance.length).toBe(4);
    // Preparer with no assignments sees firm rules only.
    const prepRules = (await call("GET", "/v1/practice/rules", { user: PREP })).json.items;
    expect(prepRules.map((r: { scope: string }) => r.scope)).toEqual(["practice"]);
    expect((await call("GET", "/v1/practice/rules?scope=client", { user: PB })).json.items).toEqual([]);
    // Suggestions explain new items for a new client.
    const c3 = (await call("POST", "/v1/practice/clients", { user: M, body: { name: "Gamma Ltd" } })).json.tenantId;
    await imp(c3, "Date,Description,Amount\n05/08/2026,MYSTERY PAYEE 12,-9.00\n");
    const s = (await call("GET", `/v1/practice/clients/${c3}/suggestions`, { user: M })).json;
    expect(s.items[0].suggested).toMatchObject({ categoryCode: "6700", reasonCodes: ["learned_practice_rule"] });
    expect(s.items[0].suggested.evidence).toEqual(firm.provenance);
    expect((await call("POST", `/v1/practice/rules/${firm.id}/disable`, { user: REV })).status).toBe(403);
    expect((await call("POST", `/v1/practice/rules/${firm.id}/disable`, { user: M })).json.status).toBe("disabled");
    expect((await call("POST", `/v1/practice/rules/${firm.id}/disable`, { user: M })).status).toBe(409);
    expect((await call("GET", `/v1/practice/clients/${c3}/suggestions`, { user: M })).json.items[0].suggested).toBeNull();
    await call("POST", "/v1/practice/learning/derive", { user: M });
    expect((await call("GET", "/v1/practice/rules?scope=practice", { user: M })).json.items[0].status).toBe("disabled");
    expect((await call("POST", `/v1/practice/rules/${firm.id}/enable`, { user: M })).json.status).toBe("active");
    expect((await call("POST", `/v1/practice/rules/${firm.id}/enable`, { user: PB })).status).toBe(404);
    expect((await call("POST", "/v1/practice/rules/nope/enable", { user: M })).status).toBe(404);
    expect((await call("GET", `/v1/practice/clients/${c3}/suggestions`, { user: PB })).status).toBe(404);
  });
});

describe("anomalies", () => {
  it("detects, explains, dismisses (audited), and is scoped", async () => {
    await imp(a, ANOM_CSV);
    const r = (await call("GET", `/v1/practice/clients/${a}/anomalies?from=2026-01-01&to=2026-12-31`, { user: M })).json;
    const codes = r.items.map((x: { code: string }) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["duplicate_payment", "missing_receipt", "round_sum", "weekend_posting"]));
    expect(r.scanned).toBe(4);
    const dup = r.items.find((x: { code: string }) => x.code === "duplicate_payment");
    expect(dup.evidence).toHaveLength(2);
    expect(dup.reason).toMatch(/Same amount/);
    expect(
      (
        await call("POST", `/v1/practice/clients/${a}/anomalies/dismiss`, {
          user: M,
          body: { transactionId: dup.transactionId, code: "duplicate_payment", note: "Two separate tool orders (synthetic)" },
        })
      ).json.dismissed,
    ).toBe(true);
    expect(
      (
        await call("POST", `/v1/practice/clients/${a}/anomalies/dismiss`, {
          user: M,
          body: { transactionId: dup.transactionId, code: "duplicate_payment", note: "again" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("POST", `/v1/practice/clients/${a}/anomalies/dismiss`, { user: M, body: { transactionId: "nope", code: "round_sum", note: "nope" } })).status,
    ).toBe(404);
    const after = (await call("GET", `/v1/practice/clients/${a}/anomalies?from=2026-01-01&to=2026-12-31`, { user: M })).json;
    expect(after.dismissed).toBe(1);
    expect(after.items.some((x: { code: string }) => x.code === "duplicate_payment")).toBe(false);
    const all = (await call("GET", "/v1/practice/anomalies?asOf=2026-10-25", { user: M })).json.items;
    expect(all[0]).toMatchObject({ tenantId: a, client: "Alpha Ltd" });
    expect(all.some((x: { tenantId: string }) => x.tenantId === other)).toBe(false);
    expect((await call("GET", "/v1/practice/anomalies?asOf=2026-10-25", { user: PREP })).json.items).toEqual([]);
    expect((await call("GET", `/v1/practice/clients/${a}/anomalies`, { user: PB })).status).toBe(404);
    expect((await call("GET", `/v1/practice/clients/${a}/anomalies`, { user: PREP })).status).toBe(404);
  });
});

describe("accuracy harness + drift", () => {
  it("measures AI vs final categories and is scoped per client", async () => {
    await imp(a, BANK_CSV);
    const items = await queue(a);
    const withCat = items.filter((i) => i.categoryCode && i.categoryCode !== "9999");
    const [first, ...rest] = withCat;
    await call("POST", "/v1/practice/review/approve", {
      user: M,
      body: { items: [{ clientId: a, transactionId: first!.transactionId, categoryCode: first!.categoryCode === "6200" ? "6300" : "6200" }] },
    });
    await call("POST", "/v1/practice/review/approve", { user: M, body: { items: rest.map((i) => ({ clientId: a, transactionId: i.transactionId })) } });
    const e = (await call("GET", "/v1/practice/eval", { user: M })).json;
    expect(e.overall.n).toBe(withCat.length);
    expect(e.overall.correct).toBe(withCat.length - 1);
    expect(e.topConfusions).toHaveLength(1);
    expect((await call("GET", `/v1/practice/eval?clientId=${b}`, { user: M })).json.overall.n).toBe(0);
    expect((await call("GET", `/v1/practice/eval?clientId=${a}`, { user: PB })).status).toBe(404);
    expect((await call("GET", "/v1/practice/eval", { user: PREP })).json.overall.n).toBe(0);
    expect((await call("GET", "/v1/practice/drift?minN=5", { user: M })).json.alerts).toEqual(expect.any(Array));
  });
  it("drift alert fires on synthetic review history", async () => {
    const ins = h.raw.prepare(
      "insert into review_log (practice_id, tenant_id, id, transaction_id, ai_category_code, ai_confidence, final_category_code, method, reviewed_by, reviewed_at) values (?, ?, ?, 'tx', '6200', 0.8, ?, 'manual', 'm', ?)",
    );
    const pid = (await call("GET", "/v1/practice", { user: M })).json.id;
    for (let i = 0; i < 40; i++) ins.run(pid, a, `old${i}`, i < 38 ? "6200" : "6300", "2026-08-01T00:00:00Z");
    for (let i = 0; i < 30; i++) ins.run(pid, a, `new${i}`, i < 21 ? "6200" : "6300", "2026-10-20T00:00:00Z");
    const d = (await call("GET", "/v1/practice/drift?asOf=2026-10-25", { user: M })).json.alerts;
    expect(d.map((x: { code: string; scope: string }) => `${x.code}:${x.scope}`)).toEqual(expect.arrayContaining(["accuracy_drop:all", `accuracy_drop:${a}`]));
    expect((await call("GET", "/v1/practice/drift?asOf=2026-10-25", { user: PB })).json.alerts).toEqual([]);
  });
});

describe("practice assistant", () => {
  it("routes by rules, answers from data with citations, and never cites clients outside scope", async () => {
    await imp(a, BANK_CSV);
    await call("POST", `/v1/practice/clients/${a}/queries`, { user: M, body: { question: "What is the mystery payee?" } });
    await call("POST", `/v1/practice/clients/${a}/document-requests`, { user: M, body: { titles: ["Bank statement July"], dueDate: "2026-08-01" } });
    const ask = (question: string, user = M, extra: Record<string, unknown> = {}) =>
      call("POST", "/v1/practice/assistant", { user, body: { question, asOf: "2026-10-25", ...extra } });
    const backlog = (await ask("How many items are awaiting review?")).json;
    expect(backlog).toMatchObject({ intent: "review_backlog", router: "rules" });
    expect(backlog.answer).toMatch(/awaiting review across 1 client/);
    expect(backlog.citations.some((c: { id: string }) => c.id === a)).toBe(true);
    expect((await ask("Which clients are at risk?")).json.citations[0].kind).toBe("client");
    expect((await ask("open queries?")).json.answer).toMatch(/1 query/);
    expect((await ask("which documents are missing?")).json.answer).toMatch(/1 document request\(s\) outstanding, 1 overdue/);
    expect((await ask("any duplicate or unusual payments?")).json.intent).toBe("anomalies");
    expect((await ask("how accurate is categorisation?")).json.answer).toMatch(/No reviewed items|survived review/);
    expect((await ask("What WIP can we bill?")).json.intent).toBe("wip");
    const dl = (await ask("which deadlines are due?")).json;
    expect(dl.intent).toBe("upcoming_deadlines");
    expect(dl.answer).toMatch(/UNVERIFIED|No upcoming/);
    expect((await ask("which returns are overdue?")).json.intent).toBe("overdue_deadlines");
    // Mock LLM fallback only picks an intent.
    expect((await ask("who is slipping behind?")).json).toMatchObject({ intent: "worst_health", router: "mock-llm" });
    expect((await ask("tell me a joke")).json).toMatchObject({ intent: null, router: "none" });
    // Scope: preparer has no assignments, firm B sees nothing of firm A.
    expect((await ask("How many items are awaiting review?", PREP)).json.answer).toBe("Nothing is awaiting review.");
    const fb = (await ask("Which clients are at risk?", PB)).json;
    expect(JSON.stringify(fb)).not.toContain("Alpha");
    expect((await ask("backlog", PB, { clientId: a })).status).toBe(404);
    const scoped = (await ask("review backlog", M, { clientId: b })).json;
    expect(scoped.answer).toBe("Nothing is awaiting review.");
    // A malicious router can only choose intents; it cannot widen scope.
    setLlmRouter({ name: "evil", route: async () => "worst_health" });
    expect(JSON.stringify((await ask("zzz", PB)).json)).not.toContain("Alpha");
  });
});
