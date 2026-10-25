import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  detectAnomalies,
  driftAlerts,
  evaluate,
  learnPracticeRules,
  routeIntent,
  suggestFromRules,
  ALL_INTENTS,
  type AnomalyTxn,
  type ReviewRecord,
} from "../src/intelligence.js";

const t = (o: Partial<AnomalyTxn> & { id: string }): AnomalyTxn => ({
  date: "2026-07-01",
  description: "X",
  amountPence: -1000,
  categoryCode: "6200",
  vatRateCode: null,
  vatPence: null,
  hasReceipt: true,
  ...o,
});

describe("detectAnomalies", () => {
  it("flags duplicates within the window with graded severity, and not outside it or for income", () => {
    const a = detectAnomalies([
      t({ id: "a", date: "2026-07-01", description: "ACME TOOLS 123", amountPence: -12_000 }),
      t({ id: "b", date: "2026-07-01", description: "ACME TOOLS 456", amountPence: -12_000 }),
      t({ id: "c", date: "2026-07-05", description: "ACME TOOLS", amountPence: -12_000 }),
      t({ id: "d", date: "2026-07-20", description: "ACME TOOLS", amountPence: -12_000 }),
      t({ id: "e", date: "2026-07-01", description: "CLIENT PAY", amountPence: 5_000 }),
      t({ id: "f", date: "2026-07-01", description: "CLIENT PAY", amountPence: 5_000 }),
    ]).filter((x) => x.code === "duplicate_payment");
    expect(a.map((x) => [x.transactionId, x.severity, x.confidence])).toEqual([
      ["b", "high", 0.9],
      ["c", "medium", 0.6],
    ]);
    expect(a[0]!.evidence).toEqual(["a", "b"]);
    expect(a[0]!.reason).toContain("£120.00");
  });
  it("missing receipts by threshold; unusual VAT; round sums; weekends", () => {
    const out = detectAnomalies(
      [
        t({ id: "r1", amountPence: -25_000, hasReceipt: false }),
        t({ id: "r2", amountPence: -24_999, hasReceipt: false }),
        t({ id: "r3", amountPence: -100_000, hasReceipt: false }),
        t({ id: "r4", amountPence: -30_000, hasReceipt: false, categoryCode: "9999" }),
        t({ id: "v1", amountPence: -12_000, vatRateCode: "STD", vatPence: 2_000 }),
        t({ id: "v2", amountPence: -12_000, vatRateCode: "STD", vatPence: 2_400 }),
        t({ id: "v3", amountPence: -12_000, vatRateCode: "ZERO", vatPence: 100 }),
        t({ id: "v4", amountPence: -10_500, vatRateCode: "RED", vatPence: 500 }),
        t({ id: "o1", amountPence: -50_000 }),
        t({ id: "o2", amountPence: -49_999 }),
        t({ id: "o3", amountPence: -60_050 }),
        t({ id: "w1", date: "2026-07-04" }),
        t({ id: "w2", date: "2026-07-05" }),
        t({ id: "w3", date: "2026-07-06" }),
      ],
      {},
    );
    const ids = (code: string) =>
      out
        .filter((x) => x.code === code)
        .map((x) => x.transactionId)
        .sort();
    expect(ids("missing_receipt")).toEqual(["r1", "r3", "r4"]);
    expect(out.find((x) => x.transactionId === "r3" && x.code === "missing_receipt")!.severity).toBe("high");
    expect(ids("unusual_vat")).toEqual(["v2", "v3"]);
    expect(out.find((x) => x.transactionId === "v3")!.severity).toBe("high");
    expect(ids("round_sum")).toEqual(["o1", "r3"]);
    expect(ids("weekend_posting")).toEqual(["w1", "w2"]);
    expect(out[0]!.severity).toBe("high");
    expect(out.at(-1)!.severity).toBe("low");
    expect(detectAnomalies([t({ id: "x", amountPence: -30_000, hasReceipt: false })], { receiptThresholdPence: 50_000 })).toEqual([]);
  });
  it("never throws and every anomaly cites its transaction", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            date: fc.integer({ min: 0, max: 365 }).map((d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10)),
            description: fc.option(fc.string()),
            amountPence: fc.integer({ min: -10_000_000, max: 10_000_000 }),
            categoryCode: fc.option(fc.constantFrom("6200", "9999")),
            vatRateCode: fc.option(fc.constantFrom("STD", "RED", "ZERO", "XXX")),
            vatPence: fc.option(fc.integer({ min: -100_000, max: 100_000 })),
            hasReceipt: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (xs) => detectAnomalies(xs).every((a) => a.evidence.includes(a.transactionId) && a.confidence > 0 && a.confidence <= 1),
      ),
    ));
});

const rec = (o: Partial<ReviewRecord>): ReviewRecord => ({
  tenantId: "t1",
  aiCategoryCode: "6200",
  aiConfidence: 0.9,
  finalCategoryCode: "6200",
  method: "manual",
  reviewedAt: "2026-07-01T10:00:00Z",
  ...o,
});
describe("evaluate", () => {
  it("accuracy, buckets, calibration and confusions; auto_rule excluded", () => {
    const e = evaluate([
      rec({}),
      rec({ finalCategoryCode: "6300" }),
      rec({ aiConfidence: 0.99, reviewedAt: "2026-08-02T00:00:00Z", tenantId: "t2" }),
      rec({ aiCategoryCode: null, aiConfidence: null, finalCategoryCode: "6300", tenantId: "t2" }),
      rec({ method: "auto_rule" }),
      rec({ aiConfidence: 0.6, method: "bulk" }),
      rec({ aiConfidence: 0.3, method: "qa", finalCategoryCode: "6300" }),
    ]);
    expect(e.overall).toMatchObject({ n: 6, correct: 3, accuracy: 0.5 });
    expect(e.overall.meanConfidence).toBe(0.738);
    expect(e.overall.calibrationGap).toBe(0.238);
    expect(e.excludedAutoApproved).toBe(1);
    expect(e.byMonth.map((b) => [b.key, b.n])).toEqual([
      ["2026-07", 5],
      ["2026-08", 1],
    ]);
    expect(e.byClient.map((b) => b.key)).toEqual(["t1", "t2"]);
    expect(e.byConfidenceBand.map((b) => b.key).sort()).toEqual(["0.50-0.80", "0.80-0.95", "0.95+", "<0.50", "unknown"]);
    expect(e.topConfusions).toEqual([
      { pair: "6200→6300", n: 2 },
      { pair: "none→6300", n: 1 },
    ]);
    expect(evaluate([]).overall).toEqual({ key: "all", n: 0, correct: 0, accuracy: null, meanConfidence: null, calibrationGap: null });
  });
});

describe("driftAlerts", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, 25) - d * 86_400_000).toISOString();
  const many = (n: number, ageDays: number, correctShare: number, o: Partial<ReviewRecord> = {}) =>
    Array.from({ length: n }, (_, i) => rec({ reviewedAt: day(ageDays), finalCategoryCode: i < n * correctShare ? "6200" : "6300", aiConfidence: 0.8, ...o }));
  it("flags an accuracy drop beyond the threshold, graded, for all and per client", () => {
    const a = driftAlerts([...many(40, 60, 0.95), ...many(30, 5, 0.8)], "2026-10-25");
    expect(a.filter((x) => x.code === "accuracy_drop").map((x) => [x.scope, x.severity])).toEqual([
      ["all", "high"],
      ["t1", "high"],
    ]);
    expect(driftAlerts([...many(40, 60, 0.95), ...many(30, 5, 0.92)], "2026-10-25").filter((x) => x.code === "accuracy_drop")).toEqual([]);
  });
  it("needs minN in each window; flags overconfidence and QA failure", () => {
    expect(driftAlerts([...many(40, 60, 0.95), ...many(10, 5, 0.1)], "2026-10-25")).toEqual([]);
    const o = driftAlerts(many(25, 5, 0.5, { aiConfidence: 0.95 }), "2026-10-25");
    expect(o.map((x) => [x.code, x.severity])).toContainEqual(["overconfidence", "high"]);
    const qa = driftAlerts(many(6, 3, 0.5, { method: "qa" }), "2026-10-25", { minN: 20 });
    expect(qa.map((x) => x.code)).toEqual(["qa_failure_rate"]);
    expect(qa[0]!.severity).toBe("high");
    expect(driftAlerts(many(6, 3, 1, { method: "qa" }), "2026-10-25")).toEqual([]);
  });
});

describe("practice learning", () => {
  const c = (reviewId: string, tenantId: string, description: string, categoryCode = "6400", at = "2026-07-01T00:00:00Z") => ({
    reviewId,
    tenantId,
    description,
    categoryCode,
    amountPence: -1000,
    at,
  });
  it("one client makes a client rule; two clients agreeing make a firm rule with merged provenance", () => {
    const one = learnPracticeRules([c("r1", "a", "SHELL FUEL A40"), c("r2", "a", "SHELL FUEL M4")], "2026-07-02T00:00:00Z");
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ scope: "client", tenantId: "a", categoryCode: "6400", provenance: ["r1", "r2"] });
    const two = learnPracticeRules(
      [c("r1", "a", "SHELL FUEL A40"), c("r2", "a", "SHELL FUEL M4"), c("r3", "b", "SHELL FUEL"), c("r4", "b", "SHELL FUEL 2")],
      "2026-07-02T00:00:00Z",
    );
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ scope: "practice", tenantId: null, clients: 2, evidence: 4, provenance: ["r1", "r2", "r3", "r4"] });
    expect(learnPracticeRules([c("r1", "a", "SHELL FUEL"), c("r2", "b", "SHELL FUEL")], "2026-07-02T00:00:00Z")).toEqual([]);
  });
  it("suggestFromRules prefers client rules and respects direction", () => {
    const rules = [
      { pattern: "SHELL FUEL", categoryCode: "6400", confidence: 0.8, scope: "practice" as const, direction: "out" as const, provenance: ["r1"] },
      { pattern: "SHELL FUEL", categoryCode: "6500", confidence: 0.7, scope: "client" as const, direction: "any" as const, provenance: ["r2", "r3"] },
    ];
    const s = suggestFromRules("SHELL FUEL 99", -100, rules)!;
    expect(s.categoryCode).toBe("6500");
    expect(s.reasonCodes).toEqual(["learned_client_rule"]);
    expect(s.evidence).toEqual(["r2", "r3"]);
    expect(suggestFromRules("SHELL FUEL 99", -100, [rules[0]!])!.reasonCodes).toEqual(["learned_practice_rule"]);
    expect(suggestFromRules("SHELL FUEL 99", 100, [rules[0]!])).toBeNull();
    expect(suggestFromRules("NOTHING", -1, rules)).toBeNull();
  });
});

describe("routeIntent", () => {
  it.each([
    ["Which VAT returns are overdue?", "overdue_deadlines"],
    ["any missed deadlines", "overdue_deadlines"],
    ["what is due next week", "upcoming_deadlines"],
    ["how big is the review backlog", "review_backlog"],
    ["which clients are at risk", "worst_health"],
    ["show duplicate payments", "anomalies"],
    ["open queries please", "open_queries"],
    ["what wip can we bill", "wip"],
    ["missing receipts", "missing_documents"],
    ["how accurate is the AI", "accuracy"],
  ])("%s → %s", (q, intent) => expect(routeIntent(q)?.intent).toBe(intent));
  it("returns null for unrelated text and lists all intents", () => {
    expect(routeIntent("tell me a joke")).toBeNull();
    expect(ALL_INTENTS).toHaveLength(9);
  });
});
