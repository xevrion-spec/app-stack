/**
 * Boundary tests written against surviving mutants (Stryker run on the agent review core). Each case pins an exact
 * edge: an off-by-one comparison, a guardrail branch, a refinement path, or a schema limit.
 */
import { describe, it, expect } from "vitest";
import {
  evaluate,
  getPath,
  PolicyDocument,
  PolicyRule,
  type EvalInput,
  CreateReviewRequest,
  DecideReviewRequest,
  initial,
  apply,
  TransitionError,
  FINAL,
  loadSigningKey,
} from "../src/index.js";

const base: EvalInput = { action: "a.b", risk: "medium", confidence: 0.8, tags: ["x"], payload: { amount: 10, tier: "gold", nested: { k: 1 } } };
const rule = (when: Record<string, unknown>, then: Record<string, unknown> = { outcome: "reject" }) =>
  PolicyDocument.parse({ rules: [{ id: "r", when, then }] });
const hits = (when: Record<string, unknown>, input: Partial<EvalInput> = {}) => evaluate(rule(when), { ...base, ...input }).ruleId === "r";

describe("payload conditions at the boundary", () => {
  it.each([
    ["gt", 10, false],
    ["gt", 9, true],
    ["gte", 10, true],
    ["gte", 11, false],
    ["lt", 10, false],
    ["lt", 11, true],
    ["lte", 10, true],
    ["lte", 9, false],
  ])("amount %s %d → %s", (op, value, want) => expect(hits({ payload: [{ path: "amount", op, value }] })).toBe(want));
  it("numeric ops never match non-numbers on either side", () => {
    expect(hits({ payload: [{ path: "tier", op: "gte", value: 0 }] })).toBe(false);
    expect(hits({ payload: [{ path: "amount", op: "lte", value: "100" }] })).toBe(false);
  });
  it("exists / eq / neq / in", () => {
    expect(hits({ payload: [{ path: "nested.k", op: "exists" }] })).toBe(true);
    expect(hits({ payload: [{ path: "nested.zz", op: "exists" }] })).toBe(false);
    expect(hits({ payload: [{ path: "tier", op: "eq", value: "gold" }] })).toBe(true);
    expect(hits({ payload: [{ path: "tier", op: "eq", value: "silver" }] })).toBe(false);
    expect(hits({ payload: [{ path: "tier", op: "neq", value: "gold" }] })).toBe(false);
    expect(hits({ payload: [{ path: "tier", op: "neq", value: "silver" }] })).toBe(true);
    expect(hits({ payload: [{ path: "tier", op: "in", value: ["gold", "x"] }] })).toBe(true);
    expect(hits({ payload: [{ path: "tier", op: "in", value: "gold" }] })).toBe(false);
  });
  it("getPath stops at null, primitives and inherited keys", () => {
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
    expect(getPath({ a: 5 }, "a.b")).toBeUndefined();
    expect(getPath({}, "toString")).toBeUndefined();
    expect(getPath({ a: { b: 0 } }, "a.b")).toBe(0);
  });
  it("trace records each failing predicate by name", () => {
    const r = evaluate(
      rule({ action: "z.*", risk: ["low"], minConfidence: 0.9, maxConfidence: 0.1, tagsAny: ["nope"], payload: [{ path: "amount", op: "gt", value: 99 }] }),
      base,
    );
    expect(r.trace[0]!.failed).toEqual(["action", "risk", "minConfidence", "maxConfidence", "tagsAny", "payload[0]"]);
  });
  it("confidence bands are inclusive and need a number", () => {
    expect(hits({ minConfidence: 0.8 })).toBe(true);
    expect(hits({ minConfidence: 0.81 })).toBe(false);
    expect(hits({ maxConfidence: 0.8 })).toBe(true);
    expect(hits({ maxConfidence: 0.79 })).toBe(false);
    expect(hits({ minConfidence: 0 }, { confidence: null })).toBe(false);
    expect(hits({ maxConfidence: 1 }, { confidence: null })).toBe(false);
    expect(hits({ tagsAny: ["x", "y"] })).toBe(true);
    expect(hits({ tagsAny: ["x", "y"] }, { tags: ["y"] })).toBe(true);
    expect(hits({ risk: ["medium"] })).toBe(true);
  });
});

describe("guardrails hold even for documents that skipped validation", () => {
  const raw = (then: Record<string, unknown>, when: Record<string, unknown> = {}) =>
    ({ rules: [{ id: "r", when, then }], default: { outcome: "human", approvals: 1 } }) as PolicyDocument;
  it("critical is never auto-approved and gets four eyes", () => {
    const r = evaluate(raw({ outcome: "auto_approve", approvals: 1 }, { minConfidence: 0.5 }), { ...base, risk: "critical" });
    expect([r.outcome, r.approvals, r.guardrails]).toEqual(["human", 2, ["critical_never_auto", "critical_four_eyes"]]);
  });
  it("auto-approve needs the request's confidence to clear the rule's floor (inclusive)", () => {
    expect(evaluate(raw({ outcome: "auto_approve", approvals: 1 }), base).guardrails).toEqual(["confidence_required_for_auto"]);
    expect(evaluate(raw({ outcome: "auto_approve", approvals: 1 }, { minConfidence: 0.8 }), base)).toMatchObject({ outcome: "auto_approve", guardrails: [] });
    expect(evaluate(raw({ outcome: "auto_approve", approvals: 1 }, { minConfidence: 0.8 }), { ...base, confidence: null }).outcome).toBe("human");
  });
  it("four-eyes only raises below 2 and only for human review", () => {
    expect(evaluate(raw({ outcome: "human", approvals: 2 }), { ...base, risk: "critical" })).toMatchObject({ approvals: 2, guardrails: [] });
    expect(evaluate(raw({ outcome: "human", approvals: 3 }), { ...base, risk: "critical" }).approvals).toBe(3);
    expect(evaluate(raw({ outcome: "reject", approvals: 1 }), { ...base, risk: "critical" })).toMatchObject({
      outcome: "reject",
      approvals: 1,
      guardrails: [],
    });
  });
  it("callers may raise approvals (never lower) and doing so forces a human", () => {
    expect(evaluate(raw({ outcome: "human", approvals: 2 }), { ...base, minApprovals: 2 })).toMatchObject({ approvals: 2, guardrails: [] });
    expect(evaluate(raw({ outcome: "human", approvals: 3 }), { ...base, minApprovals: 1 }).approvals).toBe(3);
    const auto = evaluate(raw({ outcome: "auto_approve", approvals: 1 }, { minConfidence: 0.5 }), { ...base, minApprovals: 2 });
    expect([auto.outcome, auto.approvals, auto.guardrails]).toEqual(["human", 2, ["caller_requested_human"]]);
    const humanRaise = evaluate(raw({ outcome: "human", approvals: 1 }), { ...base, minApprovals: 3 });
    expect([humanRaise.approvals, humanRaise.guardrails]).toEqual([3, []]);
  });
});

describe("save-time refinements report the exact field", () => {
  const issues = (doc: unknown) => (PolicyDocument.safeParse(doc).error?.issues ?? []).map((i) => [i.path.join("."), i.message]);
  it("auto rules", () => {
    expect(issues({ rules: [{ id: "a", when: { risk: ["low"], minConfidence: 0.49 }, then: { outcome: "auto_approve" } }] })).toEqual([
      ["rules.0.when.minConfidence", "auto_approve rules must require minConfidence >= 0.5"],
    ]);
    expect(issues({ rules: [{ id: "a", when: { risk: ["low"], minConfidence: 0.5 }, then: { outcome: "auto_approve" } }] })).toEqual([]);
    expect(issues({ rules: [{ id: "a", when: { minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] })).toEqual([
      ["rules.0.when.risk", "auto_approve rules must list risk levels and may not include critical"],
    ]);
    expect(issues({ rules: [{ id: "a", when: { risk: ["low", "critical"], minConfidence: 0.9 }, then: { outcome: "auto_approve" } }] })).toHaveLength(1);
    expect(issues({ rules: [{ id: "a", when: {}, then: { outcome: "human" } }] })).toEqual([]);
  });
  it("duplicate ids and auto default", () => {
    expect(
      issues({
        rules: [
          { id: "a", when: {}, then: { outcome: "human" } },
          { id: "a", when: {}, then: { outcome: "reject" } },
        ],
      }),
    ).toEqual([["rules.1.id", "duplicate rule id a"]]);
    expect(issues({ rules: [], default: { outcome: "auto_approve" } })).toEqual([["default.outcome", "the default outcome cannot be auto_approve"]]);
  });
  it("limits", () => {
    const r = (o: Record<string, unknown>) => PolicyRule.safeParse({ id: "a", when: {}, then: { outcome: "human", ...o } }).success;
    expect([r({ approvals: 1 }), r({ approvals: 5 }), r({ approvals: 0 }), r({ approvals: 6 })]).toEqual([true, true, false, false]);
    expect([r({ timeoutSeconds: 10 }), r({ timeoutSeconds: 30 * 86400 }), r({ timeoutSeconds: 9 }), r({ timeoutSeconds: 30 * 86400 + 1 })]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([
      r({ escalateAfterSeconds: 10 }),
      r({ escalateAfterSeconds: 30 * 86400 }),
      r({ escalateAfterSeconds: 9 }),
      r({ escalateAfterSeconds: 30 * 86400 + 1 }),
    ]).toEqual([true, true, false, false]);
    expect([
      r({ group: "g".repeat(60) }),
      r({ group: "g".repeat(61) }),
      r({ escalateToGroup: "g".repeat(60) }),
      r({ escalateToGroup: "g".repeat(61) }),
    ]).toEqual([true, false, true, false]);
    expect(r({ outcome: "reject" }) && r({ outcome: "auto_approve" }) === false).toBe(true);
    const w = (o: Record<string, unknown>) => PolicyRule.safeParse({ id: "a", when: o, then: { outcome: "human" } }).success;
    expect([
      w({ tagsAny: Array(20).fill("t") }),
      w({ tagsAny: Array(21).fill("t") }),
      w({ tagsAny: ["t".repeat(40)] }),
      w({ tagsAny: ["t".repeat(41)] }),
    ]).toEqual([true, false, true, false]);
    expect([w({ payload: Array(20).fill({ path: "a", op: "exists" }) }), w({ payload: Array(21).fill({ path: "a", op: "exists" }) })]).toEqual([true, false]);
    expect([w({ minConfidence: 0 }), w({ maxConfidence: 1 }), w({ minConfidence: 1.01 }), w({ maxConfidence: -0.1 })]).toEqual([true, true, false, false]);
    const id = (s: string, d?: string) => PolicyRule.safeParse({ id: s, description: d, when: {}, then: { outcome: "human" } }).success;
    expect([id("a".repeat(60)), id("a".repeat(61)), id(""), id("a", "d".repeat(300)), id("a", "d".repeat(301))]).toEqual([true, false, false, true, false]);
    expect(PolicyDocument.safeParse({ rules: Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, when: {}, then: { outcome: "human" } })) }).success).toBe(
      true,
    );
    expect(PolicyDocument.safeParse({ rules: Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, when: {}, then: { outcome: "human" } })) }).success).toBe(
      false,
    );
    expect(PolicyDocument.parse({ rules: [] }).default).toEqual({ outcome: "human", approvals: 1 });
  });
});

describe("request schema limits", () => {
  const ok = (o: Record<string, unknown>) => CreateReviewRequest.safeParse({ action: "a.b", payload: {}, ...o }).success;
  it("bounds", () => {
    expect([ok({ confidence: 0 }), ok({ confidence: 1 }), ok({ confidence: -0.01 }), ok({ confidence: 1.01 })]).toEqual([true, true, false, false]);
    expect([ok({ timeoutSeconds: 10 }), ok({ timeoutSeconds: 30 * 24 * 3600 }), ok({ timeoutSeconds: 9 }), ok({ timeoutSeconds: 30 * 24 * 3600 + 1 })]).toEqual(
      [true, true, false, false],
    );
    expect([ok({ minApprovals: 1 }), ok({ minApprovals: 5 }), ok({ minApprovals: 0 }), ok({ minApprovals: 6 })]).toEqual([true, true, false, false]);
    expect([ok({ externalId: "e".repeat(200) }), ok({ externalId: "e".repeat(201) })]).toEqual([true, false]);
    expect([ok({ tags: Array(20).fill("t") }), ok({ tags: Array(21).fill("t") }), ok({ tags: ["t".repeat(40)] }), ok({ tags: ["t".repeat(41)] })]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect([ok({ callbackUrl: `https://a.example/${"p".repeat(1970)}` }), ok({ callbackUrl: `https://a.example/${"p".repeat(2000)}` })]).toEqual([true, false]);
    expect([ok({ deadlineAt: "2027-01-01T00:00:00+01:00" }), ok({ deadlineAt: "2027-01-01T00:00:00Z" }), ok({ deadlineAt: "tomorrow" })]).toEqual([
      true,
      true,
      false,
    ]);
    expect([ok({ action: "a.b-c:d_e" }), ok({ action: "A.b" }), ok({ action: "a b" }), ok({ action: ".a" }), ok({ action: "ok\nbad" })]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(CreateReviewRequest.parse({ action: "a", payload: {} }).tags).toEqual([]);
  });
  it("64KB JSON cap is inclusive with a clear message", () => {
    const at = (n: number) => ({ s: "x".repeat(n - 8) }); // {"s":"…"} adds 8 bytes
    expect(ok({ payload: at(65536) })).toBe(true);
    const over = CreateReviewRequest.safeParse({ action: "a", payload: at(65537) });
    expect(over.error?.issues[0]?.message).toBe("must be at most 65536 bytes as JSON");
  });
  it("edits need a payload; reasons are capped", () => {
    const d = (o: Record<string, unknown>) => DecideReviewRequest.safeParse(o);
    expect(d({ decision: "edit" }).error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([["payload", "payload is required for edit"]]);
    expect([d({ decision: "approve", reason: "r".repeat(2000) }).success, d({ decision: "approve", reason: "r".repeat(2001) }).success]).toEqual([true, false]);
  });
});

describe("state machine edges", () => {
  it("errors carry a name, a code and a message", () => {
    try {
      apply({ ...initial("agent", 1), status: "approved" }, { type: "expire" });
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect([(e as TransitionError).name, (e as TransitionError).code, (e as Error).message]).toEqual([
        "TransitionError",
        "already_final",
        "Request is already approved",
      ]);
    }
    expect(() => apply(initial("agent", 1), { type: "cancel", by: "x" })).toThrow("Only the requester can cancel");
    expect(() => apply(initial("agent", 1), { type: "decide", decision: "approve", reviewer: "agent" })).toThrow("The requester cannot decide its own request");
    const once = apply(initial("agent", 2), { type: "decide", decision: "approve", reviewer: "r1" });
    expect(() => apply(once, { type: "decide", decision: "approve", reviewer: "r1" })).toThrow("This reviewer already decided this version");
    const esc = apply(initial("agent", 1), { type: "decide", decision: "escalate", reviewer: "r1" });
    expect(() => apply(esc, { type: "decide", decision: "escalate", reviewer: "r2" })).toThrow("Already escalated");
  });
  it("initial state is empty and every final status is final", () => {
    expect(initial("a", 1)).toEqual({ status: "pending", requester: "a", requiredApprovals: 1, payloadVersion: 1, approvals: [], deciders: [] });
    expect(() => initial("a", 0)).toThrow("requiredApprovals must be 1..5");
    expect([...FINAL].sort()).toEqual(["approved", "cancelled", "expired", "rejected"]);
  });
  it("an editor's later edit is allowed, and deciders record the exact version", () => {
    const e1 = apply(initial("agent", 2), { type: "decide", decision: "edit", reviewer: "r1" });
    expect(e1.deciders).toEqual([
      { reviewer: "r1", version: 1 },
      { reviewer: "r1", version: 2 },
    ]);
    const e2 = apply(e1, { type: "decide", decision: "edit", reviewer: "r1" });
    expect([e2.payloadVersion, e2.status]).toEqual([3, "pending"]);
    expect(() => apply(e2, { type: "decide", decision: "approve", reviewer: "r1" })).toThrow(TransitionError);
  });
});

describe("signing key validation", () => {
  it.each([
    [{ kty: "EC", crv: "Ed25519", d: "a", x: "b", kid: "k" }],
    [{ kty: "OKP", crv: "X25519", d: "a", x: "b", kid: "k" }],
    [{ kty: "OKP", crv: "Ed25519", x: "b", kid: "k" }],
    [{ kty: "OKP", crv: "Ed25519", d: "a", kid: "k" }],
  ])("rejects %j", async (j) => expect(loadSigningKey(JSON.stringify(j))).rejects.toThrow("RECEIPT_SIGNING_JWK must be an Ed25519 private JWK with kid"));
});
