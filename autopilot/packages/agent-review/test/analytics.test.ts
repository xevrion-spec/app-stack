import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_POLICY,
  draftPolicy,
  evaluate,
  PolicyDocument,
  quantile,
  reviewerStats,
  suggestAutoApprove,
  wilsonLower,
  type DecisionRow,
  type OutcomeRow,
} from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
function dec(reviewer: string, decision: DecisionRow["decision"], requestId: string, secs: number, risk: DecisionRow["risk"] = "low"): DecisionRow {
  return { reviewer, decision, requestId, requestCreatedAt: iso(0), decidedAt: iso(secs), risk };
}
const rows = (n: number, f: (i: number) => OutcomeRow) => Array.from({ length: n }, (_, i) => f(i));

describe("quantile and Wilson", () => {
  it("quantile picks nearest-rank and handles empty", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(quantile([7], 0)).toBe(7);
  });
  it("Wilson lower bound is known values, below p, monotone in n", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(50, 50)).toBeCloseTo(0.9287, 3);
    expect(wilsonLower(95, 100)).toBeCloseTo(0.8883, 3);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, p) => {
        const k = Math.round(p * n);
        const lb = wilsonLower(k, n);
        expect(lb).toBeGreaterThanOrEqual(-1e-12);
        expect(lb).toBeLessThanOrEqual(k / n + 1e-12);
        expect(wilsonLower(k * 2, n * 2)).toBeGreaterThanOrEqual(lb - 1e-12);
      }),
    );
  });
});

describe("reviewerStats (D3)", () => {
  it("computes counts, latency percentiles, approve rates and disagreement; low-sample gets no rates", () => {
    const r: DecisionRow[] = [];
    for (let i = 0; i < 20; i++) {
      r.push(dec("ann", i < 15 ? "approve" : "reject", `q${i}`, 60 + i, i < 10 ? "high" : "low"));
      r.push(dec("bob", i < 10 ? "approve" : "reject", `q${i}`, 2));
    }
    r.push(dec("cat", "approve", "z1", 1), dec("cat", "edit", "z2", 3), dec("cat", "escalate", "z3", 5));
    const [ann, bob, cat] = reviewerStats(r);
    expect(ann!.reviewer).toBe("ann");
    expect(ann!.counts).toEqual({ approve: 15, reject: 5, edit: 0, escalate: 0 });
    expect(ann!.medianSeconds).toBe(69);
    expect(ann!.p90Seconds).toBe(77);
    expect(ann!.approveRate).toBe(0.75);
    expect(ann!.approveRateHighRisk).toBe(1);
    expect(ann!.flags).toEqual(["approves_high_risk_more"]);
    expect(ann!.disagreementRate).toBe(0.25);
    expect(bob!.disagreementRate).toBe(0.25);
    expect(bob!.approveRateHighRisk).toBeNull();
    expect(cat!.flags).toEqual(["low_sample"]);
    expect(cat!.approveRate).toBeNull();
    expect(cat!.disagreementRate).toBeNull();
    expect(cat!.counts.edit).toBe(1);
  });
  it("flags fast rubber-stamping only with enough sample and a high approve rate", () => {
    const fast = reviewerStats(Array.from({ length: 12 }, (_, i) => dec("speedy", "approve", `r${i}`, 2)));
    expect(fast[0]!.flags).toEqual(["fast_approvals"]);
    const mixed = reviewerStats(Array.from({ length: 12 }, (_, i) => dec("m", i % 2 ? "approve" : "reject", `r${i}`, 2)));
    expect(mixed[0]!.flags).toEqual([]);
    const slow = reviewerStats(Array.from({ length: 12 }, (_, i) => dec("s", "approve", `r${i}`, 30)));
    expect(slow[0]!.flags).toEqual([]);
    expect(reviewerStats([])).toEqual([]);
  });
  it("negative clock skew is clamped to 0s and sorting is deterministic", () => {
    const s = reviewerStats([{ ...dec("a", "approve", "x", 0), decidedAt: iso(-5) }, dec("b", "approve", "y", 1)]);
    expect(s.map((x) => x.reviewer)).toEqual(["a", "b"]);
    expect(s[0]!.medianSeconds).toBe(0);
  });
});

describe("suggestAutoApprove (D4)", () => {
  const clean = (action: string, risk: OutcomeRow["risk"] = "low", confidence: number | null = 0.95): OutcomeRow => ({
    action,
    risk,
    confidence,
    status: "approved",
    edited: false,
  });
  it("suggests a guarded draft rule with shadow replay numbers that validates and routes as expected", () => {
    const data = [
      ...rows(200, (i) => clean("email.send", "low", 0.8 + (i % 20) / 100)),
      ...rows(5, () => ({ ...clean("email.send", "low", 0.3), status: "rejected" as const })),
    ];
    const [s, ...rest] = suggestAutoApprove(data);
    expect(rest).toEqual([]);
    expect(s!.minConfidence).toBe(0.81);
    expect(s!.shadow).toEqual({ wouldAutoApprove: 190, wouldHaveBeenRejected: 0, wouldHaveBeenEdited: 0, excludedLowConfidence: 15 });
    expect(s!.wilsonLower).toBeGreaterThanOrEqual(0.97);
    const doc = draftPolicy(DEFAULT_POLICY, [s!]);
    expect(evaluate(doc, { action: "email.send", risk: "low", confidence: 0.9, payload: {} }).outcome).toBe("auto_approve");
    expect(evaluate(doc, { action: "email.send", risk: "low", confidence: 0.5, payload: {} }).outcome).toBe("human");
    expect(evaluate(doc, { action: "email.send", risk: "high", confidence: 0.99, payload: {} }).outcome).toBe("human");
    expect(draftPolicy(doc, [s!]).rules).toHaveLength(1);
  });
  it("never suggests high/critical, small samples, edited/rejected-heavy groups, missing confidence, or glob actions", () => {
    expect(suggestAutoApprove(rows(300, () => clean("wire", "high")))).toEqual([]);
    expect(suggestAutoApprove(rows(300, () => clean("wire", "critical")))).toEqual([]);
    expect(suggestAutoApprove(rows(30, () => clean("a")))).toEqual([]);
    expect(suggestAutoApprove(rows(300, (i) => ({ ...clean("a"), edited: i % 10 === 0 })))).toEqual([]);
    expect(suggestAutoApprove(rows(300, (i) => ({ ...clean("a"), status: i % 15 ? "approved" : "expired" })))).toEqual([]);
    expect(suggestAutoApprove(rows(300, () => clean("a", "low", null)))).toEqual([]);
    expect(suggestAutoApprove(rows(300, () => clean("refund.*")))).toEqual([]);
    expect(suggestAutoApprove(rows(300, () => clean("x".repeat(121))))).toEqual([]);
  });
  it("clamps options: minSample floor 20, target within [0.9, 0.999]", () => {
    expect(
      suggestAutoApprove(
        rows(40, () => clean("a")),
        { minSample: 1, target: 0.9 },
      ),
    ).toHaveLength(1);
    expect(
      suggestAutoApprove(
        rows(19, () => clean("a")),
        { minSample: 1, target: 0.9 },
      ),
    ).toEqual([]);
    expect(
      suggestAutoApprove(
        rows(60, () => clean("a")),
        { target: 0.5 },
      ),
    ).toHaveLength(1);
    expect(
      suggestAutoApprove(
        rows(4000, () => clean("a")),
        { target: 1 },
      ),
    ).toHaveLength(1);
    expect(
      suggestAutoApprove(
        rows(1000, () => clean("a")),
        { target: 1 },
      ),
    ).toEqual([]);
  });
  it("property: every suggestion is valid policy, low/medium only, minConfidence >= 0.5, LB >= target", () => {
    const row = fc.record({
      action: fc.constantFrom("a", "b.c", "d"),
      risk: fc.constantFrom("low", "medium", "high", "critical"),
      confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      status: fc.constantFrom("approved", "approved", "approved", "approved", "rejected", "expired", "cancelled"),
      edited: fc.boolean(),
    }) as fc.Arbitrary<OutcomeRow>;
    fc.assert(
      fc.property(fc.array(row, { maxLength: 400 }), (data) => {
        for (const s of suggestAutoApprove(data, { minSample: 20, target: 0.9 })) {
          expect(["low", "medium"]).toContain(s.risk);
          expect(s.minConfidence).toBeGreaterThanOrEqual(0.5);
          expect(s.wilsonLower).toBeGreaterThanOrEqual(0.9);
          expect(() => PolicyDocument.parse({ rules: [s.rule] })).not.toThrow();
        }
      }),
      { numRuns: 200 },
    );
  });
});
