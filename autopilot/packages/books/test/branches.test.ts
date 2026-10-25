import { describe, it, expect } from "vitest";
import {
  parseAccountingExport,
  parseOfx,
  parseQif,
  detectRecurring,
  forecastCash,
  addDays,
  addMonths,
  findDuplicates,
  type RecurringSeries,
} from "../src/index.js";

describe("accounting export edge cases", () => {
  it("accepts UK and long-month dates and a BOM, auto-detecting the source", () => {
    const r = parseAccountingExport(
      "\uFEFFDate,Description,Reference,Amount,Account Code\n05/01/26,A,R,-1.00,400\n6 January 2026,,R,2.00,\n7 Foo 2026,C,R,1,\n",
      undefined,
    );
    expect(r.source).toBe("xero");
    expect(r.lines.map((l) => l.date)).toEqual(["2026-01-05", "2026-01-06"]);
    expect(r.lines[1]!.description).toBe("(no description)");
    expect(r.rejected).toEqual([{ row: 4, error: "invalid date" }]);
  });
  it("throws on empty, unknown or incomplete files", () => {
    expect(() => parseAccountingExport("")).toThrow(/empty/);
    expect(() => parseAccountingExport("x,y\n1,2")).toThrow(/unrecognised/);
    expect(() => parseAccountingExport("Description,Category\nA,B", "freshbooks")).toThrow(/missing required/);
  });
  it("rejects rows with neither debit nor credit", () => {
    const r = parseAccountingExport("Date,Description,Debit,Credit,Account\n2026-01-05,X,,,Y\n", "quickbooks");
    expect(r.rejected[0]!.error).toBe("invalid amount");
  });
});

describe("statement edge cases", () => {
  it("OFX bad amount is rejected; no NAME gives no counterparty", () => {
    const r = parseOfx("<OFX><STMTTRN><DTPOSTED>20260101<TRNAMT>abc<FITID>1</STMTTRN><STMTTRN><DTPOSTED>20260102<TRNAMT>1.00</STMTTRN></OFX>");
    expect(r.rejected[0]!.error).toMatch(/TRNAMT/);
    expect(r.lines[0]).toEqual({ date: "2026-01-02", description: "(no description)", amountPence: 100 });
    expect(r.account).toEqual({});
  });
  it("QIF month-first, 2-digit apostrophe years, U amounts and bad amounts", () => {
    const r = parseQif("!Type:Bank\nD1/7'26\nU-5.00\nPX\n^\nD01/02/2026\nTabc\n^\n", { dayFirst: false });
    expect(r.lines[0]).toMatchObject({ date: "2026-01-07", amountPence: -500 });
    expect(r.rejected[0]!.error).toMatch(/amount/);
  });
});

describe("recurring cadences and variance", () => {
  const series = (step: (i: number) => string, amt: (i: number) => number, n = 6, desc = "GYM CO") =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, date: step(i), description: desc, amountPence: amt(i) }));
  it.each([
    ["fortnightly", (i: number) => addDays("2026-01-01", i * 14)],
    ["quarterly", (i: number) => addMonths("2024-01-01", i * 3)],
    ["yearly", (i: number) => addMonths("2020-01-01", i * 12)],
  ] as const)("detects %s", (cadence, step) => {
    expect(detectRecurring(series(step, () => -1000))[0]?.cadence).toBe(cadence);
  });
  it("flags varying amounts and lowers confidence", () => {
    const [s] = detectRecurring(
      series(
        (i) => addMonths("2026-01-01", i),
        (i) => (i % 2 ? -1000 : -2000),
      ),
    );
    expect(s!.amountVaries).toBe(true);
    expect(s!.confidence).toBeLessThan(1);
  });
  it("skips zero amounts, empty merchants and same-day gaps", () => {
    expect(
      detectRecurring(
        series(
          (i) => addMonths("2026-01-01", i),
          () => 0,
        ),
      ),
    ).toEqual([]);
    expect(
      detectRecurring(
        series(
          () => "2026-01-01",
          () => -100,
        ),
      ),
    ).toEqual([]);
    expect(
      detectRecurring(
        series(
          (i) => addMonths("2026-01-01", i),
          () => -100,
          6,
          "1234",
        ),
      ),
    ).toEqual([]);
  });
});

describe("forecast details", () => {
  const base: RecurringSeries = {
    key: "k",
    direction: "out",
    cadence: "weekly",
    occurrences: 6,
    typicalAmountPence: 100,
    amountVaries: false,
    lastDate: "2025-12-01",
    nextExpectedDate: "2025-12-08",
    transactionIds: [],
    confidence: 0.9,
  };
  it.each(["weekly", "fortnightly", "monthly", "quarterly", "yearly"] as const)("rolls stale %s series forward past today", (cadence) => {
    const f = forecastCash({ today: "2026-01-15", balancePence: 0, recurring: [{ ...base, cadence }], history: [], horizonDays: 400 });
    expect(f.flows.every((x) => x.date > "2026-01-15")).toBe(true);
    expect(f.flows.length).toBeGreaterThan(0);
  });
  it("adds average non-recurring flow and starts at 0 runway when overdrawn", () => {
    const f = forecastCash({
      today: "2026-01-15",
      balancePence: -5,
      recurring: [],
      history: [
        { date: "2026-01-10", amountPence: -9000, recurring: false },
        { date: "2026-01-11", amountPence: -1, recurring: true },
      ],
      horizonDays: 28,
      lookbackDays: 90,
    });
    expect(f.runwayDays).toBe(0);
    expect(f.flows.every((x) => x.source === "average non-recurring" && x.pence === -700)).toBe(true);
    expect(f.points[0]).toEqual({ date: "2026-01-15", balancePence: -5 });
  });
});

describe("duplicates within one upload", () => {
  it("matches a repeated row in the same file and exact same-day text", () => {
    const m = findDuplicates(
      [
        { id: "a", date: "2026-01-01", description: "X LTD", amountPence: 5 },
        { id: "b", date: "2026-01-01", description: "x ltd", amountPence: 5 },
      ],
      [],
    );
    expect(m).toEqual([expect.objectContaining({ id: "b", duplicateOf: "a", kind: "exact" })]);
  });
});
