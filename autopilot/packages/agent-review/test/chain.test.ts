import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { initialChain, apply, currentStep, TransitionError, initial } from "../src/state.js";
import { PolicyDocument, evaluate, resolveSteps } from "../src/policy.js";

const steps = () => [
  { name: "lead", group: "leads", approvals: 1 },
  { name: "finance", group: "finance", approvals: 2 },
];
const ok = (s: ReturnType<typeof initialChain>, who: string, decision: "approve" | "reject" | "edit" | "escalate" = "approve") =>
  apply(s, { type: "decide", decision, reviewer: who });

describe("approval chains", () => {
  it("clears steps in order and approves after the last", () => {
    let s = initialChain("agent", steps());
    expect(s.requiredApprovals).toBe(3);
    expect(currentStep(s)!.name).toBe("lead");
    s = ok(s, "lee");
    expect([s.status, currentStep(s)!.name]).toEqual(["pending", "finance"]);
    s = ok(s, "fay");
    expect([s.status, s.stepIndex]).toEqual(["pending", 1]);
    s = ok(s, "fin");
    expect([s.status, s.stepIndex, currentStep(s)]).toEqual(["approved", 2, null]);
    expect(s.approvals.map((a) => a.step)).toEqual([0, 1, 1]);
  });
  it("separation of duties: one person counts in one step only; reject vetoes anywhere", () => {
    let s = ok(initialChain("agent", steps()), "lee");
    expect(() => ok(s, "lee")).toThrow(TransitionError);
    s = ok(s, "fay");
    expect(ok(s, "zed", "reject").status).toBe("rejected");
  });
  it("an edit restarts the chain and the editor cannot approve their own version", () => {
    let s = ok(ok(initialChain("agent", steps()), "lee"), "fay");
    s = ok(s, "fin", "edit");
    expect([s.status, s.stepIndex, s.payloadVersion]).toEqual(["pending", 0, 2]);
    expect(() => ok(s, "fin")).toThrow(TransitionError);
    s = ok(ok(ok(s, "lee"), "fay"), "max");
    expect(s.status).toBe("approved");
  });
  it("escalation: advancing a step returns to pending", () => {
    let s = ok(initialChain("agent", steps()), "esc", "escalate");
    expect(s.status).toBe("escalated");
    s = ok(s, "lee");
    expect([s.status, s.stepIndex]).toEqual(["pending", 1]);
    const one = ok(initialChain("agent", [{ name: "a", group: null, approvals: 2 }]), "esc", "escalate");
    expect(ok(one, "x").status).toBe("escalated");
  });
  it("rejects bad shapes; single-step requests are unchanged", () => {
    expect(() => initialChain("a", [])).toThrow(RangeError);
    expect(() =>
      initialChain(
        "a",
        Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, group: null, approvals: 1 })),
      ),
    ).toThrow(RangeError);
    expect(() => initialChain("a", [{ name: "x", group: null, approvals: 0 }])).toThrow(RangeError);
    expect(() => initialChain("a", [{ name: "x", group: null, approvals: 11 }])).toThrow(RangeError);
    expect(() => initialChain("a", [{ name: "x", group: null, approvals: 1.5 }])).toThrow(RangeError);
    expect(
      initialChain("a", [
        { name: "x", group: null, approvals: 10 },
        { name: "y", group: null, approvals: 10 },
      ]).requiredApprovals,
    ).toBe(20);
    const plain = initial("a", 1);
    expect(currentStep(plain)).toBeNull();
    expect(ok(plain, "r").status).toBe("approved");
  });
  it("property: approved iff each step got its count of distinct people, in order", () =>
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }), (counts) => {
        let s = initialChain(
          "agent",
          counts.map((n, i) => ({ name: `s${i}`, group: null, approvals: n })),
        );
        let k = 0;
        counts.forEach((n, i) => {
          for (let j = 0; j < n; j++) {
            expect(s.status).toBe("pending");
            expect(s.stepIndex).toBe(i);
            s = ok(s, `p${k++}`);
          }
        });
        expect(s.status).toBe("approved");
        expect(s.approvals.length).toBe(counts.reduce((a, b) => a + b, 0));
      }),
    ));
});

describe("chain policy + quorum", () => {
  const doc = PolicyDocument.parse({
    rules: [
      {
        id: "big-refund",
        when: { action: "refund.*" },
        then: {
          outcome: "human",
          steps: [
            { name: "lead", group: "leads", approvals: 1 },
            { name: "board", group: "board", quorumPercent: 50 },
          ],
          clock: "business",
        },
      },
    ],
  });
  it("evaluate carries steps and clock; default has none", () => {
    const r = evaluate(doc, { action: "refund.issue", risk: "low", payload: {} });
    expect(r.steps).toHaveLength(2);
    expect(r.clock).toBe("business");
    const d = evaluate(doc, { action: "email.send", risk: "low", payload: {} });
    expect([d.steps, d.clock]).toEqual([null, "wall"]);
  });
  it("schema: chains need human outcome, exactly one of approvals/quorumPercent, quorum needs a group", () => {
    const bad = (then: unknown) => PolicyDocument.safeParse({ rules: [{ id: "x", when: {}, then }] }).success;
    expect(bad({ outcome: "reject", steps: [{ name: "a", approvals: 1 }] })).toBe(false);
    expect(bad({ outcome: "human", steps: [{ name: "a" }] })).toBe(false);
    expect(bad({ outcome: "human", steps: [{ name: "a", approvals: 1, quorumPercent: 50, group: "g" }] })).toBe(false);
    expect(bad({ outcome: "human", steps: [{ name: "a", quorumPercent: 50 }] })).toBe(false);
    expect(bad({ outcome: "human", steps: [{ name: "a", quorumPercent: 50, group: "g" }] })).toBe(true);
    expect(bad({ outcome: "human", steps: [] })).toBe(false);
  });
  it("resolveSteps: quorum of members, caps and empty groups flagged, critical four-eyes, caller minimum", () => {
    const size = (g: string) => ({ leads: 3, board: 5, empty: 0, huge: 40 })[g] ?? 0;
    expect(resolveSteps([{ name: "b", group: "board", quorumPercent: 50 }], size, { risk: "low" })).toEqual({
      steps: [{ name: "b", group: "board", approvals: 3 }],
      guardrails: [],
    });
    expect(resolveSteps([{ name: "b", group: "board", quorumPercent: 100 }], size, { risk: "low" }).steps[0]!.approvals).toBe(5);
    expect(resolveSteps([{ name: "h", group: "huge", quorumPercent: 100 }], size, { risk: "low" })).toEqual({
      steps: [{ name: "h", group: "huge", approvals: 10 }],
      guardrails: ["quorum_capped:h"],
    });
    expect(resolveSteps([{ name: "e", group: "empty", quorumPercent: 60 }], size, { risk: "low" })).toEqual({
      steps: [{ name: "e", group: "empty", approvals: 1 }],
      guardrails: ["quorum_empty_group:e"],
    });
    expect(resolveSteps([{ name: "l", group: "leads", approvals: 5 }], size, { risk: "low" }).guardrails).toEqual([]);
    expect(resolveSteps([{ name: "x", approvals: 1 }], size, { risk: "critical" })).toEqual({
      steps: [{ name: "x", group: null, approvals: 2 }],
      guardrails: ["critical_four_eyes"],
    });
    expect(
      resolveSteps(
        [
          { name: "x", approvals: 1 },
          { name: "y", approvals: 1 },
        ],
        size,
        { risk: "critical" },
      ).guardrails,
    ).toEqual([]);
    expect(
      resolveSteps(
        [
          { name: "x", approvals: 1 },
          { name: "y", approvals: 1 },
        ],
        size,
        { risk: "low", minApprovals: 4 },
      ).steps.map((s) => s.approvals),
    ).toEqual([1, 3]);
    expect(resolveSteps([{ name: "x", approvals: 9 }], size, { risk: "low", minApprovals: 20 }).steps[0]!.approvals).toBe(10);
    expect(resolveSteps([{ name: "x", approvals: 3 }], size, { risk: "low", minApprovals: 2 }).steps[0]!.approvals).toBe(3);
  });
});
