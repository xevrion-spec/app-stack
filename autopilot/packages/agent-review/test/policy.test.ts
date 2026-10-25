import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bucket, DEFAULT_POLICY, evaluate, getPath, globMatch, PolicyDocument, RISK_LEVELS, type EvalInput } from "../src/index.js";

const policy = PolicyDocument.parse({
  rules: [
    { id: "block-wire", when: { action: "payment.wire", payload: [{ path: "amount", op: "gt", value: 10000 }] }, then: { outcome: "reject" } },
    {
      id: "small-refunds",
      when: { action: "refund.*", risk: ["low", "medium"], minConfidence: 0.9, payload: [{ path: "amount", op: "lte", value: 50 }] },
      then: { outcome: "auto_approve" },
    },
    {
      id: "vip",
      when: { payload: [{ path: "customer.tier", op: "in", value: ["gold", "platinum"] }] },
      then: { outcome: "human", approvals: 2, group: "leads", escalateAfterSeconds: 600, escalateToGroup: "managers" },
    },
    { id: "tagged", when: { tagsAny: ["legal"], maxConfidence: 0.99 }, then: { outcome: "human", group: "legal", timeoutSeconds: 3600 } },
  ],
});
const base: EvalInput = { action: "refund.issue", risk: "low", confidence: 0.95, payload: { amount: 20 } };

describe("policy engine", () => {
  it("first match wins with a trace", () => {
    const r = evaluate(policy, base);
    expect([r.outcome, r.ruleId, r.guardrails]).toEqual(["auto_approve", "small-refunds", []]);
    expect(r.trace.map((t) => t.matched)).toEqual([false, true]);
    expect(r.trace[0]!.failed).toEqual(["action", "payload[0]"]);
  });
  it("routes by payload, tags and groups; reject rules", () => {
    expect(evaluate(policy, { ...base, action: "payment.wire", payload: { amount: 20000 } }).outcome).toBe("reject");
    const vip = evaluate(policy, { ...base, payload: { amount: 500, customer: { tier: "gold" } } });
    expect(vip).toMatchObject({ outcome: "human", approvals: 2, group: "leads", escalateAfterSeconds: 600, escalateToGroup: "managers", ruleId: "vip" });
    expect(evaluate(policy, { ...base, payload: { amount: 500 }, tags: ["legal"], confidence: 0.5 })).toMatchObject({ group: "legal", timeoutSeconds: 3600 });
    expect(evaluate(policy, { ...base, payload: { amount: 500 }, tags: ["legal"], confidence: null }).ruleId).toBeNull(); // maxConfidence needs a confidence
    expect(evaluate(policy, { ...base, payload: { amount: 500 } })).toMatchObject({ outcome: "human", approvals: 1, ruleId: null });
  });
  it("guardrails: missing confidence, caller minApprovals, critical four-eyes", () => {
    expect(evaluate(policy, { ...base, confidence: undefined }).ruleId).toBe(null);
    const raised = evaluate(policy, { ...base, minApprovals: 2 });
    expect([raised.outcome, raised.approvals, raised.guardrails]).toEqual(["human", 2, ["caller_requested_human"]]);
    expect(evaluate(DEFAULT_POLICY, { ...base, risk: "critical" })).toMatchObject({ outcome: "human", approvals: 2, guardrails: ["critical_four_eyes"] });
  });
  it("save-time validation refuses unsafe policies", () => {
    const bad = (rules: unknown[], extra: object = {}) => PolicyDocument.safeParse({ rules, ...extra }).success;
    expect(bad([{ id: "a", when: { risk: ["low"] }, then: { outcome: "auto_approve" } }])).toBe(false);
    expect(bad([{ id: "a", when: { risk: ["low"], minConfidence: 0.3 }, then: { outcome: "auto_approve" } }])).toBe(false);
    expect(bad([{ id: "a", when: { minConfidence: 0.9 }, then: { outcome: "auto_approve" } }])).toBe(false);
    expect(bad([{ id: "a", when: { risk: ["critical"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }])).toBe(false);
    expect(
      bad([
        { id: "a", then: { outcome: "human" } },
        { id: "a", then: { outcome: "human" } },
      ]),
    ).toBe(false);
    expect(bad([], { default: { outcome: "auto_approve" } })).toBe(false);
    expect(bad([{ id: "a", when: { payload: [{ path: "a..b", op: "eq", value: 1 }] }, then: { outcome: "human" } }])).toBe(false);
  });
  it("helpers", () => {
    expect([globMatch("refund.*", "refund.issue"), globMatch("refund.*", "refunds"), globMatch("a.b", "aXb"), globMatch("*", "x")]).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect([getPath({ a: { b: 1 } }, "a.b"), getPath({ a: 1 }, "a.b"), getPath({}, "constructor")]).toEqual([1, undefined, undefined]);
    const ops = PolicyDocument.parse({
      rules: ["eq", "neq", "gte", "lt", "exists"].map((op, i) => ({
        id: `r${i}`,
        when: { payload: [{ path: "n", op, value: 5 }] },
        then: { outcome: "human", group: op },
      })),
    });
    expect(evaluate(ops, { ...base, payload: { n: 5 } }).group).toBe("eq");
    expect(evaluate(ops, { ...base, payload: { n: 6 } }).group).toBe("neq");
    expect(evaluate(ops, { ...base, payload: { n: "5" } }).group).toBe("neq");
    expect(
      evaluate(PolicyDocument.parse({ rules: [{ id: "x", when: { payload: [{ path: "n", op: "lt", value: 5 }] }, then: { outcome: "reject" } }] }), {
        ...base,
        payload: { n: "1" },
      }).outcome,
    ).toBe("human");
  });
});

const input: fc.Arbitrary<EvalInput> = fc.record({
  action: fc.constantFrom("refund.issue", "payment.wire", "email.send"),
  risk: fc.constantFrom(...RISK_LEVELS),
  confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
  tags: fc.array(fc.constantFrom("legal", "vip", "x"), { maxLength: 3 }),
  payload: fc.record({ amount: fc.integer({ min: 0, max: 50000 }), customer: fc.record({ tier: fc.constantFrom("gold", "basic") }) }),
  minApprovals: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
});
describe("policy guardrail properties", () => {
  it("never auto-approves critical or unconfident requests, never lowers approvals, is deterministic", () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = evaluate(policy, i);
        if (r.outcome === "auto_approve") {
          expect(i.risk).not.toBe("critical");
          expect(typeof i.confidence === "number" && i.confidence >= 0.9).toBe(true);
          expect(i.minApprovals ?? 1).toBeLessThanOrEqual(1);
        }
        if (i.risk === "critical" && r.outcome === "human") expect(r.approvals).toBeGreaterThanOrEqual(2);
        expect(r.approvals).toBeGreaterThanOrEqual(i.minApprovals ?? 1);
        expect(evaluate(policy, i)).toEqual(r);
      }),
      { numRuns: 3000 },
    );
  });
  it("canary buckets are stable and roughly uniform", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) counts[Math.floor(bucket(`req-${i}`) / 10)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
    expect(bucket("abc")).toBe(bucket("abc"));
  });
});
