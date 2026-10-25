import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { apply, currentApprovals, DECISIONS, FINAL, initial, TransitionError, type ReviewEvent, type Snapshot } from "../src/index.js";

const decide = (decision: "approve" | "reject" | "edit" | "escalate", reviewer: string): ReviewEvent => ({ type: "decide", decision, reviewer });

describe("agent review state machine", () => {
  it("single approver approves", () => {
    expect(apply(initial("agent", 1), decide("approve", "ann")).status).toBe("approved");
  });
  it("four-eyes needs two distinct reviewers", () => {
    const a = apply(initial("agent", 2), decide("approve", "ann"));
    expect(a.status).toBe("pending");
    expect(() => apply(a, decide("approve", "ann"))).toThrow(TransitionError);
    expect(apply(a, decide("approve", "bob")).status).toBe("approved");
  });
  it("an edit invalidates approvals of the old payload", () => {
    let s = apply(initial("agent", 2), decide("approve", "ann"));
    s = apply(s, decide("edit", "bob"));
    expect(s.status).toBe("pending");
    expect(s.payloadVersion).toBe(2);
    expect(currentApprovals(s)).toBe(1);
    s = apply(s, decide("approve", "ann")); // ann must re-approve what will actually run
    expect(s.status).toBe("approved");
  });
  it("edit by a single approver approves the edited version", () => {
    const s = apply(initial("agent", 1), decide("edit", "ann"));
    expect([s.status, s.payloadVersion]).toEqual(["approved", 2]);
  });
  it("reject is a veto, escalate once, requester rules, expiry and cancel", () => {
    expect(apply(apply(initial("agent", 3), decide("approve", "a")), decide("reject", "b")).status).toBe("rejected");
    const e = apply(initial("agent", 1), decide("escalate", "a"));
    expect(e.status).toBe("escalated");
    expect(() => apply(e, decide("escalate", "b"))).toThrow(/Already escalated/);
    expect(apply(e, decide("approve", "b")).status).toBe("approved");
    expect(() => apply(initial("agent", 1), decide("approve", "agent"))).toThrow(/cannot decide/);
    expect(apply(initial("agent", 1), decide("reject", "agent")).status).toBe("rejected"); // an agent may withdraw by rejecting
    expect(apply(initial("agent", 1), { type: "expire" }).status).toBe("expired");
    expect(() => apply(initial("agent", 1), { type: "cancel", by: "x" })).toThrow(/Only the requester/);
    expect(apply(initial("agent", 1), { type: "cancel", by: "agent" }).status).toBe("cancelled");
    expect(() => initial("agent", 0)).toThrow(RangeError);
    expect(() => initial("agent", 6)).toThrow(RangeError);
  });
});

const reviewer = fc.constantFrom("agent", "ann", "bob", "cat", "dan");
const event: fc.Arbitrary<ReviewEvent> = fc.oneof(
  fc.record({ type: fc.constant("decide" as const), decision: fc.constantFrom(...DECISIONS), reviewer }),
  fc.constant({ type: "expire" as const }),
  fc.record({ type: fc.constant("cancel" as const), by: reviewer }),
);
function run(req: number, evs: ReviewEvent[]) {
  const trace: Snapshot[] = [initial("agent", req)];
  for (const e of evs) {
    const cur = trace[trace.length - 1]!;
    try {
      trace.push(apply(cur, e));
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      trace.push(cur);
    }
  }
  return trace;
}

describe("agent review state machine properties", () => {
  it("final states absorb, approval implies quorum of distinct non-requesters on the current version", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.array(event, { maxLength: 30 }), (req, evs) => {
        const trace = run(req, evs);
        for (let i = 1; i < trace.length; i++) {
          if (FINAL.has(trace[i - 1]!.status)) expect(trace[i]).toBe(trace[i - 1]);
          expect(trace[i]!.payloadVersion).toBeGreaterThanOrEqual(trace[i - 1]!.payloadVersion);
        }
        const last = trace[trace.length - 1]!;
        const approvers = last.approvals.filter((a) => a.version === last.payloadVersion).map((a) => a.reviewer);
        expect(approvers).not.toContain("agent");
        if (last.status === "approved") expect(new Set(approvers).size).toBeGreaterThanOrEqual(req);
        else expect(new Set(approvers).size).toBeLessThan(req + 1);
      }),
      { numRuns: 2000 },
    );
  });
  it("never throws anything except TransitionError and never mutates its input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.array(event, { maxLength: 20 }), (req, evs) => {
        let s = initial("agent", req);
        for (const e of evs) {
          const before = s;
          const frozen = JSON.stringify(before);
          try {
            s = apply(before, e);
          } catch (err) {
            expect(err).toBeInstanceOf(TransitionError);
          }
          expect(JSON.stringify(before)).toBe(frozen);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
