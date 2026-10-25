import { describe, expect, it } from "vitest";
import { CreateReviewRequest, DecideReviewRequest } from "../src/index.js";

describe("wire schemas", () => {
  it("applies defaults and validates action names", () => {
    const r = CreateReviewRequest.parse({ action: "refund.issue", payload: { amount: 120 } });
    expect([r.risk, r.tags]).toEqual(["medium", []]);
    expect(CreateReviewRequest.safeParse({ action: "Refund Issue", payload: {} }).success).toBe(false);
  });
  it("bounds payload size", () => {
    expect(CreateReviewRequest.safeParse({ action: "a", payload: { big: "x".repeat(70_000) } }).success).toBe(false);
  });
  it("edit requires a payload", () => {
    expect(DecideReviewRequest.safeParse({ decision: "edit" }).success).toBe(false);
    expect(DecideReviewRequest.safeParse({ decision: "edit", payload: { a: 1 } }).success).toBe(true);
    expect(DecideReviewRequest.safeParse({ decision: "approve" }).success).toBe(true);
  });
});

import { canonicalJson } from "../src/index.js";
import fc from "fast-check";
describe("canonicalJson", () => {
  it("is key-order independent, drops undefined, and round-trips", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(JSON.parse(canonicalJson(v))).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });
});
