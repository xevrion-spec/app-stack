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
