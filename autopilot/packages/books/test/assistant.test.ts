import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseQuestion, parsePeriod, gbp, MockLlmRouter } from "../src/index.js";

const T = "2026-08-20";
describe("parsePeriod", () => {
  it.each([
    ["last month", "2026-07-01", "2026-07-31"],
    ["this month", "2026-08-01", T],
    ["last 30 days", "2026-07-21", T],
    ["this tax year", "2026-04-06", T],
    ["last tax year", "2025-04-06", "2026-04-05"],
    ["last quarter", "2026-04-01", "2026-06-30"],
    ["this year", "2026-01-01", T],
    ["last year", "2025-01-01", "2025-12-31"],
    ["in March", "2026-03-01", "2026-03-31"],
    ["in December", "2025-12-01", "2025-12-31"],
    ["in feb 2024", "2024-02-01", "2024-02-29"],
    ["during 2025", "2025-01-01", "2025-12-31"],
    ["whenever", "2026-08-01", T],
  ])("%s", (q, from, to) => expect(parsePeriod(q, T)).toMatchObject({ from, to }));
  it("last month in January crosses the year", () => expect(parsePeriod("last month", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" }));
  it("tax year before 6 April belongs to the previous year", () => expect(parsePeriod("this tax year", "2026-04-05").from).toBe("2025-04-06"));
});

describe("parseQuestion", () => {
  it.each([
    ["How much did I spend on travel last month?", "spend", "travel"],
    ["What was my profit this tax year", "profit", null],
    ["Who owes me money?", "outstanding_invoices", null],
    ["Which invoices are overdue", "outstanding_invoices", null],
    ["What are my biggest suppliers this year", "top_merchants", null],
    ["How long will my cash last", "runway", null],
    ["How much tax should I set aside", "tax_estimate", null],
    ["What is my VAT this quarter", "vat", null],
    ["What subscriptions am I paying for", "recurring", null],
    ["What was my income in July", "income", null],
    ["Tell me a joke", "unknown", null],
  ])("%s", (q, intent, category) => {
    const r = parseQuestion(q, T);
    expect(r.intent).toBe(intent);
    expect(r.category).toBe(category);
  });
  it("extracts a merchant when no category matched", () => expect(parseQuestion("How much did I spend at screwfix last month", T).merchant).toBe("screwfix"));
  it("never throws and always yields a valid period", () =>
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (q) => {
        const r = parseQuestion(q, T);
        expect(r.from <= r.to).toBe(true);
      }),
    ));
});

describe("helpers", () => {
  it("formats GBP", () => {
    expect(gbp(123456)).toBe("£1,234.56");
    expect(gbp(-5)).toBe("-£0.05");
  });
  it("mock LLM router only knows a paraphrase", async () => {
    const r = new MockLlmRouter();
    expect(await r.route("how much money left do I have")).toBe("runway");
    expect(await r.route("hello")).toBe("unknown");
  });
});
