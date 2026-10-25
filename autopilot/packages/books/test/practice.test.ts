import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ageBucket,
  autoApproveDecision,
  bucketCounts,
  bulkConfirmToken,
  clientDeadlines,
  clientHealth,
  firstVatPeriodEnd,
  fnv1a,
  parsePolicy,
  qaSample,
  slaState,
  wipPence,
} from "../src/practice.js";

const calm = { awaitingReview: 0, oldestAwaitingDays: 0, openQueries: 0, overdueDeadlines: 0, dueSoonDeadlines: 0, anomalies: 0, daysSinceLastActivity: 3 };
describe("clientHealth", () => {
  it("is 100/green with nothing to do", () => expect(clientHealth(calm)).toEqual({ score: 100, status: "green", reasons: [] }));
  it("explains every penalty and caps each", () => {
    const h = clientHealth({
      awaitingReview: 60,
      oldestAwaitingDays: 40,
      openQueries: 9,
      overdueDeadlines: 3,
      dueSoonDeadlines: 4,
      anomalies: 10,
      daysSinceLastActivity: 60,
    });
    expect(h.score).toBe(0);
    expect(h.status).toBe("red");
    expect(h.reasons).toEqual([
      "3 overdue deadline(s)",
      "4 deadline(s) within 14 days",
      "oldest item awaiting review is 40 days old",
      "60 items awaiting review",
      "9 open client queries",
      "10 anomalies flagged",
      "no bookkeeping activity for 60 days",
    ]);
  });
  it("exact thresholds and singular wording", () => {
    expect(clientHealth({ ...calm, overdueDeadlines: 1 })).toMatchObject({ score: 75, status: "amber" });
    expect(clientHealth({ ...calm, dueSoonDeadlines: 1 }).score).toBe(95);
    expect(clientHealth({ ...calm, dueSoonDeadlines: 3 }).score).toBe(90);
    expect(clientHealth({ ...calm, oldestAwaitingDays: 7 }).score).toBe(100);
    expect(clientHealth({ ...calm, oldestAwaitingDays: 8 }).score).toBe(99);
    expect(clientHealth({ ...calm, oldestAwaitingDays: 100 }).score).toBe(80);
    expect(clientHealth({ ...calm, awaitingReview: 50 }).score).toBe(100);
    expect(clientHealth({ ...calm, awaitingReview: 51 }).score).toBe(90);
    expect(clientHealth({ ...calm, openQueries: 1 }).reasons).toEqual(["1 open client query"]);
    expect(clientHealth({ ...calm, openQueries: 1 }).score).toBe(98);
    expect(clientHealth({ ...calm, openQueries: 6 }).score).toBe(90);
    expect(clientHealth({ ...calm, anomalies: 1 })).toMatchObject({ score: 97, reasons: ["1 anomaly flagged"] });
    expect(clientHealth({ ...calm, anomalies: 6 }).score).toBe(85);
    expect(clientHealth({ ...calm, daysSinceLastActivity: 45 }).score).toBe(100);
    expect(clientHealth({ ...calm, daysSinceLastActivity: 46 }).score).toBe(90);
    expect(clientHealth({ ...calm, daysSinceLastActivity: null }).score).toBe(100);
    expect(clientHealth({ ...calm, overdueDeadlines: 2 })).toMatchObject({ score: 60, status: "amber" });
    expect(clientHealth({ ...calm, overdueDeadlines: 5 }).score).toBe(60);
    expect(clientHealth({ ...calm, overdueDeadlines: 2, dueSoonDeadlines: 2 })).toMatchObject({ score: 50, status: "amber" });
    expect(clientHealth({ ...calm, overdueDeadlines: 2, dueSoonDeadlines: 2, anomalies: 1 })).toMatchObject({ score: 47, status: "red" });
    expect(clientHealth({ ...calm, oldestAwaitingDays: 27 })).toMatchObject({ score: 80, status: "green" });
    expect(clientHealth({ ...calm, oldestAwaitingDays: 28 }).status).toBe("green");
  });
  it("score is always within 0..100", () =>
    fc.assert(
      fc.property(fc.tuple(fc.nat(500), fc.nat(500), fc.nat(50), fc.nat(10), fc.nat(10), fc.nat(50), fc.option(fc.nat(400))), ([a, o, q, od, ds, an, l]) => {
        const s = clientHealth({
          awaitingReview: a,
          oldestAwaitingDays: o,
          openQueries: q,
          overdueDeadlines: od,
          dueSoonDeadlines: ds,
          anomalies: an,
          daysSinceLastActivity: l,
        }).score;
        return s >= 0 && s <= 100;
      }),
    ));
});

describe("ageing and SLA", () => {
  it("buckets", () => {
    expect([0, 2, 3, 7, 8, 14, 15, 99].map(ageBucket)).toEqual(["0-2d", "0-2d", "3-7d", "3-7d", "8-14d", "8-14d", "15d+", "15d+"]);
    expect(bucketCounts([0, 1, 5, 20])).toEqual({ "0-2d": 2, "3-7d": 1, "8-14d": 0, "15d+": 1 });
  });
  it("SLA states at the boundaries", () => {
    expect(slaState(0, 48)).toBe("ok");
    expect(slaState(35.9, 48)).toBe("ok");
    expect(slaState(36, 48)).toBe("due_soon");
    expect(slaState(48, 48)).toBe("due_soon");
    expect(slaState(48.01, 48)).toBe("breached");
  });
});

describe("deadline calendars", () => {
  it("VAT period ends per stagger", () => {
    expect(firstVatPeriodEnd(1, "2026-10-25")).toBe("2026-06-30");
    expect(firstVatPeriodEnd(2, "2026-10-25")).toBe("2026-04-30");
    expect(firstVatPeriodEnd(3, "2026-10-25")).toBe("2026-05-31");
    expect(firstVatPeriodEnd(1, "2026-01-15")).toBe("2025-09-30");
    expect(firstVatPeriodEnd(2, "2026-02-01")).toBe("2025-10-31");
  });
  it("client calendar includes only configured obligations, unverified, de-duplicated and sorted", () => {
    const all = clientDeadlines({ vatStagger: 1, mtdItsa: true, saRequired: true }, "2026-10-25", 120);
    expect(new Set(all.map((d) => d.kind))).toEqual(
      new Set(["vat_return", "mtd_quarterly_update", "sa_filing_online", "sa_balancing_payment", "sa_filing_paper"]),
    );
    expect(all.every((d) => d.verified === false)).toBe(true);
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
    expect(all.map((d) => d.daysLeft)).toEqual([...all.map((d) => d.daysLeft)].sort((a, b) => a - b));
    expect(clientDeadlines({ vatStagger: null, mtdItsa: false, saRequired: false }, "2026-10-25")).toEqual([]);
    const vatOnly = clientDeadlines({ vatStagger: 2, mtdItsa: false, saRequired: false }, "2026-10-25", 120);
    expect(vatOnly.map((d) => d.id)).toEqual(["vat_return:2026-10-31"]);
    expect(vatOnly.every((d) => d.kind === "vat_return")).toBe(true);
    expect(vatOnly.length).toBeGreaterThan(0);
  });
});

describe("QA sampling", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `t${i}`);
  it("is deterministic, respects the rate approximately, and picks at least one", () => {
    const a = qaSample(ids, 0.1, "seed");
    expect(qaSample(ids, 0.1, "seed")).toEqual(a);
    expect(a.length).toBeGreaterThan(60);
    expect(a.length).toBeLessThan(140);
    expect(qaSample(ids, 0.1, "other")).not.toEqual(a);
    expect(qaSample(["only"], 0.0001, "s")).toEqual(["only"]);
    expect(qaSample(ids, 0, "s")).toEqual([]);
    expect(qaSample([], 0.5, "s")).toEqual([]);
    expect(qaSample(ids.slice(0, 3), 1, "s")).toEqual(ids.slice(0, 3));
  });
  it("sample is a subset", () =>
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (xs, r) =>
        qaSample(xs, r, "k").every((x) => xs.includes(x)),
      ),
    ));
  it("fnv1a known vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("auto-approve policy", () => {
  const p = { threshold: 0.95, categories: ["6200"] };
  const t = { id: "x", categoryCode: "6200", confidence: 0.96, status: "categorised" };
  it("needs category, confidence and allowlist", () => {
    expect(autoApproveDecision(t, p)).toEqual({ approve: true, reason: "category 6200 at confidence 0.96 >= 0.95" });
    expect(autoApproveDecision({ ...t, confidence: 0.94 }, p).approve).toBe(false);
    expect(autoApproveDecision({ ...t, confidence: 0.95 }, p).approve).toBe(true);
    expect(autoApproveDecision({ ...t, confidence: null }, p).reason).toBe("confidence 0 below 0.95");
    expect(autoApproveDecision({ ...t, categoryCode: "6300" }, p).reason).toBe("category 6300 not allowlisted for auto-approval");
    expect(autoApproveDecision({ ...t, categoryCode: "9999" }, p).reason).toBe("no confident category");
    expect(autoApproveDecision({ ...t, categoryCode: null }, p).approve).toBe(false);
    expect(autoApproveDecision({ ...t, status: "needs_review" }, p).approve).toBe(false);
  });
  it("threshold has a 0.9 floor whatever the policy says", () => {
    expect(autoApproveDecision({ ...t, confidence: 0.89 }, { ...p, threshold: 0.1 }).approve).toBe(false);
    expect(autoApproveDecision({ ...t, confidence: 0.9 }, { ...p, threshold: 0.1 }).approve).toBe(true);
  });
  it("parsePolicy is defensive", () => {
    expect(parsePolicy('{"threshold":0.99,"categories":["6200",5]}')).toEqual({ threshold: 0.99, categories: ["6200"] });
    expect(parsePolicy("not json")).toEqual({ threshold: 0.97, categories: [] });
    expect(parsePolicy(null)).toEqual({ threshold: 0.97, categories: [] });
    expect(parsePolicy('{"threshold":"x","categories":"y"}')).toEqual({ threshold: 0.97, categories: [] });
  });
});

describe("WIP and bulk tokens", () => {
  it("wip by fee model", () => {
    const base = { feePence: 10_000, hourlyRatePence: 6_000, unbilledMinutes: 90, completedOutcomes: 2, monthsSinceLastBill: 3 };
    expect(wipPence({ ...base, feeModel: "hourly" })).toBe(9_000);
    expect(wipPence({ ...base, feeModel: "fixed" })).toBe(30_000);
    expect(wipPence({ ...base, feeModel: "outcome" })).toBe(20_000);
    expect(wipPence({ ...base, feeModel: "fixed", monthsSinceLastBill: -2 })).toBe(0);
    expect(wipPence({ ...base, feeModel: "outcome", completedOutcomes: -1 })).toBe(0);
    expect(wipPence({ ...base, feeModel: "hourly", unbilledMinutes: 1, hourlyRatePence: 100 })).toBe(2);
  });
  it("token is order-independent and changes with action, targets or count", () => {
    const t = bulkConfirmToken("a", ["x", "y"], 2);
    expect(t).toMatch(/^bc_[0-9a-z]+$/);
    expect(bulkConfirmToken("a", ["y", "x"], 2)).toBe(t);
    expect(bulkConfirmToken("b", ["x", "y"], 2)).not.toBe(t);
    expect(bulkConfirmToken("a", ["x"], 2)).not.toBe(t);
    expect(bulkConfirmToken("a", ["x", "y"], 3)).not.toBe(t);
  });
});
