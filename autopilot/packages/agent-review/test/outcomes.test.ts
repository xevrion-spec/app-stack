import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { outcomeSummary, type RequestFact } from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const f = (o: Partial<RequestFact> = {}): RequestFact => ({
  action: "a",
  status: "approved",
  routeOutcome: "human",
  createdAt: iso(0),
  decidedAt: iso(60),
  humanDecisions: 1,
  escalated: false,
  ...o,
});

describe("outcomeSummary (D6)", () => {
  it("empty input has no total", () => {
    expect(outcomeSummary([])).toEqual({ total: null, byAction: [] });
  });
  it("counts outcomes, auto rate, escalation/expiry, latency (human-routed only) and per-action ordering", () => {
    const rows = [
      f({ decidedAt: iso(30) }),
      f({ decidedAt: iso(90), humanDecisions: 2, escalated: true }),
      f({ status: "rejected", decidedAt: iso(10) }),
      f({ status: "expired", decidedAt: iso(500), humanDecisions: 0 }),
      f({ routeOutcome: "auto_approve", decidedAt: iso(0), humanDecisions: 0 }),
      f({ routeOutcome: "reject", status: "rejected", decidedAt: iso(0), humanDecisions: 0 }),
      f({ status: "pending", decidedAt: null, humanDecisions: 0 }),
      f({ action: "b", status: "cancelled", decidedAt: iso(-5), humanDecisions: 0 }),
    ];
    const { total, byAction } = outcomeSummary(rows);
    expect(byAction.map((x) => x.action)).toEqual(["a", "b"]);
    const a = byAction[0]!;
    expect(a.requests).toBe(7);
    expect(a.outcomes).toEqual({ pending: 1, escalated: 0, approved: 3, rejected: 2, expired: 1, cancelled: 0 });
    expect(a.autoDecidedRate).toBe(0.286);
    expect(a.escalationRate).toBe(0.143);
    expect(a.expiryRate).toBe(0.143);
    expect(a.humanDecisions).toBe(4);
    expect(a.decisionLatency).toEqual({ p50Seconds: 30, p90Seconds: 500, p99Seconds: 500 });
    expect(a.estimatedHumanCost).toBeNull();
    expect(byAction[1]!.decisionLatency.p50Seconds).toBe(0);
    expect(total!.requests).toBe(8);
    expect(total!.action).toBe("*");
  });
  it("estimates cost only when both customer inputs are given; avoided cost uses the observed human decisions per request", () => {
    const rows = [f({ humanDecisions: 2 }), f({ humanDecisions: 1 }), f({ routeOutcome: "auto_approve", humanDecisions: 0 })];
    const s = outcomeSummary(rows, { hourlyCost: 60, minutesPerDecision: 3 }).total!;
    expect(s.estimatedHumanCost).toBe(9);
    expect(s.estimatedCostAvoided).toBe(4.5);
    expect(outcomeSummary(rows, { hourlyCost: 60 }).total!.estimatedHumanCost).toBeNull();
    expect(outcomeSummary(rows, { minutesPerDecision: 3 }).total!.estimatedCostAvoided).toBeNull();
    const allAuto = outcomeSummary([f({ routeOutcome: "auto_approve", humanDecisions: 0 })], { hourlyCost: 30, minutesPerDecision: 2 }).total!;
    expect(allAuto.estimatedCostAvoided).toBe(1);
    expect(allAuto.decisionLatency.p50Seconds).toBeNull();
  });
  it("same-size actions order by name; property: outcome counts sum to requests and rates are in [0,1]", () => {
    expect(outcomeSummary([f({ action: "z" }), f({ action: "m" })]).byAction.map((x) => x.action)).toEqual(["m", "z"]);
    const st = fc.constantFrom("pending", "escalated", "approved", "rejected", "expired", "cancelled") as fc.Arbitrary<RequestFact["status"]>;
    const ro = fc.constantFrom("auto_approve", "human", "reject", null) as fc.Arbitrary<RequestFact["routeOutcome"]>;
    fc.assert(
      fc.property(
        fc.array(fc.record({ status: st, routeOutcome: ro, humanDecisions: fc.nat(3), escalated: fc.boolean(), action: fc.constantFrom("a", "b") }), {
          minLength: 1,
        }),
        (xs) => {
          const { total } = outcomeSummary(
            xs.map((x) => f(x)),
            { hourlyCost: 50, minutesPerDecision: 2 },
          );
          expect(Object.values(total!.outcomes).reduce((s, n) => s + n, 0)).toBe(xs.length);
          for (const k of ["autoDecidedRate", "escalationRate", "expiryRate"] as const) {
            expect(total![k]).toBeGreaterThanOrEqual(0);
            expect(total![k]).toBeLessThanOrEqual(1);
          }
          expect(total!.estimatedHumanCost).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
