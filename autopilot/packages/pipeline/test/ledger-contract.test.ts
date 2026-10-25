/** Ledger contract: exact journal shapes and invariant error messages (targeted at Stryker survivors). */
import { describe, it, expect } from "vitest";
import { validateJournal, journalForBankLine, LedgerInvariantError, ACCOUNTS } from "../src/index.js";

const j = (lines: { accountCode: string; debitPence: number; creditPence: number }[]) =>
  ({ entryDate: "2026-07-01", memo: "m", sourceType: "manual", sourceId: "s", lines }) as Parameters<typeof validateJournal>[0];
describe("validateJournal", () => {
  it.each([
    [[{ accountCode: "1", debitPence: 100, creditPence: 0 }], "journal needs at least two lines"],
    [
      [
        { accountCode: "1", debitPence: -100, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: -100 },
      ],
      /negative|debit/,
    ],
    [
      [
        { accountCode: "1", debitPence: 100, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: -100 },
      ],
      /negative|credit/,
    ],
    [
      [
        { accountCode: "1", debitPence: 100, creditPence: 100 },
        { accountCode: "2", debitPence: 0, creditPence: 0 },
      ],
      "a line cannot be both debit and credit",
    ],
    [
      [
        { accountCode: "1", debitPence: 100, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: 99 },
      ],
      "unbalanced journal: debits 100 != credits 99",
    ],
    [
      [
        { accountCode: "1", debitPence: 0, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: 0 },
      ],
      "empty journal",
    ],
    [
      [
        { accountCode: "1", debitPence: 1.5, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: 1.5 },
      ],
      /debit/,
    ],
    [
      [
        { accountCode: "1", debitPence: 1, creditPence: 0 },
        { accountCode: "2", debitPence: 0, creditPence: 0.5 },
      ],
      /credit/,
    ],
  ])("rejects %j", (lines, msg) => {
    expect(() => validateJournal(j(lines))).toThrow(msg as string | RegExp);
  });
  it("negative amounts are rejected even when balanced", () => {
    const e = (() => {
      try {
        validateJournal(
          j([
            { accountCode: "1", debitPence: -5, creditPence: 0 },
            { accountCode: "2", debitPence: -5, creditPence: 0 },
            { accountCode: "3", debitPence: 0, creditPence: -10 },
          ]),
        );
      } catch (x) {
        return x as Error;
      }
    })();
    expect(e).toBeInstanceOf(Error);
  });
  it("accepts a balanced two-line journal", () =>
    expect(() =>
      validateJournal(
        j([
          { accountCode: "1", debitPence: 1, creditPence: 0 },
          { accountCode: "2", debitPence: 0, creditPence: 1 },
        ]),
      ),
    ).not.toThrow());
});

describe("journalForBankLine exact shapes", () => {
  const base = { id: "t1", date: "2026-07-01", description: "D", categoryCode: "6200", vatRateCode: "STD" as string | null };
  it("expense with VAT: net to expense, VAT to control, gross from bank", () =>
    expect(journalForBankLine({ ...base, grossPence: -1200, kind: "expense", vatPence: 200 })).toEqual({
      entryDate: "2026-07-01",
      memo: "D",
      sourceType: "transaction",
      sourceId: "t1",
      lines: [
        { accountCode: "6200", debitPence: 1000, creditPence: 0, vatRateCode: "STD" },
        { accountCode: ACCOUNTS.VAT_CONTROL, debitPence: 200, creditPence: 0 },
        { accountCode: ACCOUNTS.BANK, debitPence: 0, creditPence: 1200 },
      ],
    }));
  it("income with VAT", () =>
    expect(journalForBankLine({ ...base, categoryCode: "4000", grossPence: 1200, kind: "income", vatPence: 200 }).lines).toEqual([
      { accountCode: ACCOUNTS.BANK, debitPence: 1200, creditPence: 0 },
      { accountCode: "4000", debitPence: 0, creditPence: 1000, vatRateCode: "STD" },
      { accountCode: ACCOUNTS.VAT_CONTROL, debitPence: 0, creditPence: 200 },
    ]));
  it("no VAT line when VAT is zero; vatRateCode defaults to null", () =>
    expect(journalForBankLine({ ...base, vatRateCode: undefined, grossPence: -500, kind: "expense", vatPence: 0 }).lines).toEqual([
      { accountCode: "6200", debitPence: 500, creditPence: 0, vatRateCode: null },
      { accountCode: ACCOUNTS.BANK, debitPence: 0, creditPence: 500 },
    ]));
  it.each([[-1000], [1000]])("transfers (%i) never post VAT and use savings", (g) => {
    const r = journalForBankLine({ ...base, grossPence: g, kind: "transfer", vatPence: 100 });
    expect(r.lines.map((l) => l.accountCode).sort()).toEqual([ACCOUNTS.BANK, ACCOUNTS.SAVINGS].sort());
    expect(r.lines.every((l) => l.debitPence === 1000 || l.creditPence === 1000)).toBe(true);
  });
  it("VAT is capped at gross (no negative net)", () => {
    const r = journalForBankLine({ ...base, grossPence: -100, kind: "expense", vatPence: 500 });
    expect(r.lines).toEqual([
      { accountCode: ACCOUNTS.VAT_CONTROL, debitPence: 100, creditPence: 0 },
      { accountCode: ACCOUNTS.BANK, debitPence: 0, creditPence: 100 },
    ]);
  });
  it("a zero line cannot be posted", () =>
    expect(() => journalForBankLine({ ...base, grossPence: 0, kind: "expense", vatPence: 0 })).toThrow(LedgerInvariantError));
  it("non-integer gross is rejected with a gross error", () =>
    expect(() => journalForBankLine({ ...base, grossPence: 1.5, kind: "expense", vatPence: 0 })).toThrow(/gross/));
});
