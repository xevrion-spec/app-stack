import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  draftPolicy,
  quantile,
  reviewerStats,
  suggestAutoApprove,
  type DecisionRow,
  type OutcomeRow,
  type PolicyDocument,
} from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const d = (reviewer: string, decision: DecisionRow["decision"], requestId: string, secs = 60, risk: DecisionRow["risk"] = "low"): DecisionRow => ({
  reviewer,
  decision,
  requestId,
  requestCreatedAt: iso(0),
  decidedAt: iso(secs),
  risk,
});
const n = <T>(k: number, f: (i: number) => T) => Array.from({ length: k }, (_, i) => f(i));
const one = (rows: DecisionRow[]) => reviewerStats(rows)[0]!;
const ok = (action = "a", confidence: number | null = 0.9, risk: OutcomeRow["risk"] = "low"): OutcomeRow => ({
  action,
  risk,
  confidence,
  status: "approved",
  edited: false,
});

describe("reviewerStats edges", () => {
  it("quantile clamps to the last element", () => {
    expect(quantile([1, 2, 3], 1)).toBe(3);
    expect(quantile([1, 2, 3], 2)).toBe(3);
  });
  it("sorts latencies before taking percentiles", () => {
    const s = one([d("a", "approve", "1", 50), d("a", "approve", "2", 1), d("a", "approve", "3", 30)]);
    expect(s.medianSeconds).toBe(30);
    expect(s.p90Seconds).toBe(50);
  });
  it("only approve/reject count as verdicts; exactly 10 verdicts is enough", () => {
    const edits = n(5, (i) => d("a", "edit", `e${i}`));
    expect(one([...n(10, (i) => d("a", "approve", `q${i}`)), ...edits]).approveRate).toBe(1);
    expect(one([...n(9, (i) => d("a", "approve", `q${i}`)), ...edits]).flags).toEqual(["low_sample"]);
    expect(one([...n(9, (i) => d("a", "approve", `q${i}`)), d("a", "reject", "r")]).approveRate).toBe(0.9);
  });
  it("critical counts as high risk; fewer than 10 high-risk verdicts gives no high-risk rate", () => {
    const s = one([...n(10, (i) => d("a", "approve", `c${i}`, 60, "critical")), ...n(10, (i) => d("a", "reject", `l${i}`))]);
    expect(s.approveRateHighRisk).toBe(1);
    expect(s.approveRate).toBe(0.5);
    expect(s.flags).toEqual(["approves_high_risk_more"]);
    const t = one([...n(10, (i) => d("a", i < 5 ? "approve" : "reject", `c${i}`, 60, "high")), ...n(10, (i) => d("a", i < 5 ? "approve" : "reject", `l${i}`))]);
    expect(t.approveRateHighRisk).toBe(0.5);
    expect(t.flags).toEqual([]);
    expect(one([...n(9, (i) => d("a", "approve", `c${i}`, 60, "high")), ...n(10, (i) => d("a", "reject", `l${i}`))]).approveRateHighRisk).toBeNull();
    expect(one([...n(9, (i) => d("a", "approve", `h${i}`, 60, "high")), d("a", "reject", "z", 60, "high")]).approveRateHighRisk).toBe(0.9);
  });
  it("fast_approvals boundaries: median exactly 5s is not fast; 95% approvals is", () => {
    expect(one(n(12, (i) => d("a", "approve", `q${i}`, 5))).flags).toEqual([]);
    expect(one(n(20, (i) => d("a", i ? "approve" : "reject", `q${i}`, 2))).flags).toEqual(["fast_approvals"]);
    expect(one(n(20, (i) => d("a", i > 1 ? "approve" : "reject", `q${i}`, 2))).flags).toEqual([]);
    expect(one(n(9, (i) => d("a", "approve", `q${i}`, 1))).flags).toEqual(["low_sample"]);
  });
  it("disagreement ignores solo requests, requests the reviewer did not judge, and non-verdicts", () => {
    const rows = [
      ...n(10, (i) => d("a", "approve", `s${i}`)),
      d("b", "reject", "s0"),
      d("b", "approve", "s1"),
      d("c", "edit", "s2"),
      d("b", "reject", "x"),
      d("c", "reject", "x"),
      ...n(9, (i) => d("b", "approve", `t${i}`)),
    ];
    const by = Object.fromEntries(reviewerStats(rows).map((s) => [s.reviewer, s]));
    expect(by.a!.disagreementRate).toBe(0.5);
    expect(by.b!.disagreementRate).toBe(0.333);
  });
  it("orders by decisions desc, then name", () => {
    const rows = [d("bob", "approve", "4"), d("amy", "approve", "3"), d("zed", "approve", "1"), d("zed", "approve", "2")];
    expect(reviewerStats(rows).map((s) => s.reviewer)).toEqual(["zed", "amy", "bob"]);
  });
});

describe("suggestAutoApprove edges", () => {
  it("shadow replay counts rejected/edited/low-confidence exactly", () => {
    const rows = [
      ...n(400, () => ok("a", 0.95)),
      ...n(2, () => ({ ...ok("a", 0.95), status: "rejected" as const })),
      ...n(2, () => ({ ...ok("a", 0.95), edited: true })),
      ok("a", 0.3),
    ];
    const [s] = suggestAutoApprove(rows);
    expect(s!.shadow).toEqual({ wouldAutoApprove: 404, wouldHaveBeenRejected: 2, wouldHaveBeenEdited: 2, excludedLowConfidence: 1 });
    expect(s!.rule.description).toMatch(/404 human decisions/);
  });
  it("threshold uses clean, confident approvals only", () => {
    const edited = n(5, () => ({ ...ok("a", 0.6), edited: true }));
    expect(suggestAutoApprove([...n(40, () => ok("a", 0.9)), ...edited], { minSample: 20, target: 0.9 })[0]!.minConfidence).toBe(0.9);
    expect(suggestAutoApprove([...n(40, () => ok("a", 0.9)), ...n(5, () => ok("a", null))], { minSample: 20, target: 0.9 })[0]!.minConfidence).toBe(0.9);
    const rej = n(5, () => ({ ...ok("a", 0.6), status: "rejected" as const }));
    expect(suggestAutoApprove([...n(40, () => ok("a", 0.9)), ...rej], { minSample: 20, target: 0.9 })[0]!.minConfidence).toBe(0.9);
  });
  it("exactly minSample is enough; a larger minSample is honoured", () => {
    expect(
      suggestAutoApprove(
        n(40, () => ok()),
        { minSample: 40, target: 0.9 },
      ),
    ).toHaveLength(1);
    expect(
      suggestAutoApprove(
        n(60, () => ok()),
        { minSample: 100, target: 0.9 },
      ),
    ).toEqual([]);
  });
  it("medium risk is suggestible; ids are slugged and capped; 120-char actions allowed; output sorted", () => {
    const long = "x".repeat(120);
    const out = suggestAutoApprove([...n(60, () => ok("a..b/c", 0.9, "medium")), ...n(80, () => ok(long)), ...n(60, () => ok("a..b/c"))], { target: 0.9 });
    expect(out.map((s) => s.rule.id)).toEqual([`suggested-low-${"x".repeat(46)}`, "suggested-low-a-b-c", "suggested-medium-a-b-c"]);
    expect(out[0]!.rule.id).toHaveLength(60);
  });
  it("draft keeps at most 200 rules", () => {
    const current: PolicyDocument = {
      rules: n(200, (i) => ({ id: `r${i}`, when: { action: `z${i}` }, then: { outcome: "human" as const, approvals: 1 } })),
      default: DEFAULT_POLICY.default,
    };
    const [s] = suggestAutoApprove(
      n(60, () => ok()),
      { target: 0.9 },
    );
    const doc = draftPolicy(current, [s!]);
    expect(doc.rules).toHaveLength(200);
    expect(doc.rules[0]!.id).toBe(s!.rule.id);
  });
});
