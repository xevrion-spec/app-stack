/**
 * Financial reports from the double-entry ledger: profit & loss, balance sheet, cash flow (direct method) and a tax summary
 * grouping expenses into SA103-style boxes. Pure functions over journal lines; amounts in pence.
 */
export type AccountType = "income" | "expense" | "asset" | "liability" | "equity";
export interface Account {
  code: string;
  name: string;
  type: AccountType;
  sa103?: string;
}
export interface LedgerLine {
  journalId: string;
  date: string;
  accountCode: string;
  debitPence: number;
  creditPence: number;
}

/** Fallback classification by code range when the chart does not say (UK-style numbering). */
export function classify(code: string): AccountType {
  const n = Number(code);
  if (code === "9999") return "expense"; // suspense shows in P&L so it cannot hide
  if (n >= 1000 && n < 2000) return "asset";
  if (n >= 2000 && n < 3000) return "liability";
  if (n >= 3000 && n < 4000) return "equity";
  if (n >= 4000 && n < 5000) return "income";
  return "expense";
}
const typeOf = (chart: Map<string, Account>, code: string) => chart.get(code)?.type ?? classify(code);
const nameOf = (chart: Map<string, Account>, code: string) => chart.get(code)?.name ?? code;
const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

export interface PnL {
  from: string;
  to: string;
  income: { code: string; name: string; pence: number }[];
  expenses: { code: string; name: string; pence: number }[];
  totalIncomePence: number;
  totalExpensesPence: number;
  netProfitPence: number;
}
export function profitAndLoss(lines: LedgerLine[], accounts: Account[], from: string, to: string): PnL {
  const chart = new Map(accounts.map((a) => [a.code, a]));
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (!inRange(l.date, from, to)) continue;
    const t = typeOf(chart, l.accountCode);
    if (t === "income") sums.set(l.accountCode, (sums.get(l.accountCode) ?? 0) + l.creditPence - l.debitPence);
    else if (t === "expense") sums.set(l.accountCode, (sums.get(l.accountCode) ?? 0) + l.debitPence - l.creditPence);
  }
  const rows = (t: AccountType) =>
    [...sums]
      .filter(([c, v]) => typeOf(chart, c) === t && v !== 0)
      .map(([code, pence]) => ({ code, name: nameOf(chart, code), pence }))
      .sort((a, b) => a.code.localeCompare(b.code));
  const income = rows("income");
  const expenses = rows("expense");
  const ti = income.reduce((a, r) => a + r.pence, 0);
  const te = expenses.reduce((a, r) => a + r.pence, 0);
  return { from, to, income, expenses, totalIncomePence: ti, totalExpensesPence: te, netProfitPence: ti - te };
}

export interface BalanceSheet {
  asAt: string;
  assets: { code: string; name: string; pence: number }[];
  liabilities: { code: string; name: string; pence: number }[];
  equity: { code: string; name: string; pence: number }[];
  retainedProfitPence: number;
  totalAssetsPence: number;
  totalLiabilitiesPence: number;
  totalEquityPence: number;
  balances: boolean;
}
export function balanceSheet(lines: LedgerLine[], accounts: Account[], asAt: string): BalanceSheet {
  const chart = new Map(accounts.map((a) => [a.code, a]));
  const bal = new Map<string, number>();
  let profit = 0;
  for (const l of lines) {
    if (l.date > asAt) continue;
    const t = typeOf(chart, l.accountCode);
    if (t === "income") profit += l.creditPence - l.debitPence;
    else if (t === "expense") profit -= l.debitPence - l.creditPence;
    else if (t === "asset") bal.set(l.accountCode, (bal.get(l.accountCode) ?? 0) + l.debitPence - l.creditPence);
    else bal.set(l.accountCode, (bal.get(l.accountCode) ?? 0) + l.creditPence - l.debitPence);
  }
  const rows = (t: AccountType) =>
    [...bal]
      .filter(([c, v]) => typeOf(chart, c) === t && v !== 0)
      .map(([code, pence]) => ({ code, name: nameOf(chart, code), pence }))
      .sort((a, b) => a.code.localeCompare(b.code));
  const assets = rows("asset");
  const liabilities = rows("liability");
  const equity = rows("equity");
  const ta = assets.reduce((a, r) => a + r.pence, 0);
  const tl = liabilities.reduce((a, r) => a + r.pence, 0);
  const te = equity.reduce((a, r) => a + r.pence, 0) + profit;
  return {
    asAt,
    assets,
    liabilities,
    equity,
    retainedProfitPence: profit,
    totalAssetsPence: ta,
    totalLiabilitiesPence: tl,
    totalEquityPence: te,
    balances: ta === tl + te,
  };
}

export interface CashFlow {
  from: string;
  to: string;
  openingPence: number;
  inflowsPence: number;
  outflowsPence: number;
  closingPence: number;
  byMonth: { month: string; inPence: number; outPence: number; netPence: number }[];
  byCategory: { code: string; name: string; netPence: number }[];
}
/** Direct-method cash flow over the given cash accounts (default bank + savings), attributing each movement to its journal's counter accounts. */
export function cashFlow(lines: LedgerLine[], accounts: Account[], from: string, to: string, cashAccounts = ["1200", "1210"]): CashFlow {
  const chart = new Map(accounts.map((a) => [a.code, a]));
  const cash = new Set(cashAccounts);
  let opening = 0;
  const months = new Map<string, { in: number; out: number }>();
  const cats = new Map<string, number>();
  const byJournal = new Map<string, LedgerLine[]>();
  for (const l of lines) byJournal.set(l.journalId, [...(byJournal.get(l.journalId) ?? []), l]);
  let inflows = 0,
    outflows = 0;
  for (const js of byJournal.values()) {
    const cashMove = js.filter((l) => cash.has(l.accountCode)).reduce((a, l) => a + l.debitPence - l.creditPence, 0);
    if (!cashMove) continue;
    const date = js[0]!.date;
    if (date < from) {
      opening += cashMove;
      continue;
    }
    if (date > to) continue;
    const m = date.slice(0, 7);
    const e = months.get(m) ?? { in: 0, out: 0 };
    if (cashMove > 0) {
      e.in += cashMove;
      inflows += cashMove;
    } else {
      e.out += -cashMove;
      outflows += -cashMove;
    }
    months.set(m, e);
    const counters = js.filter((l) => !cash.has(l.accountCode));
    const total = counters.reduce((a, l) => a + Math.abs(l.debitPence - l.creditPence), 0) || 1;
    let allocated = 0;
    counters.forEach((l, i) => {
      const share = i === counters.length - 1 ? cashMove - allocated : Math.round((cashMove * Math.abs(l.debitPence - l.creditPence)) / total);
      allocated += share;
      cats.set(l.accountCode, (cats.get(l.accountCode) ?? 0) + share);
    });
  }
  return {
    from,
    to,
    openingPence: opening,
    inflowsPence: inflows,
    outflowsPence: outflows,
    closingPence: opening + inflows - outflows,
    byMonth: [...months].sort().map(([month, v]) => ({ month, inPence: v.in, outPence: v.out, netPence: v.in - v.out })),
    byCategory: [...cats]
      .filter(([, v]) => v !== 0)
      .map(([code, netPence]) => ({ code, name: nameOf(chart, code), netPence }))
      .sort((a, b) => a.netPence - b.netPence || a.code.localeCompare(b.code)),
  };
}

/** SA103-style expense grouping; unmapped expense accounts land in "other" so nothing is silently dropped. */
export function taxSummary(
  pnl: PnL,
  accounts: Account[],
): { turnoverPence: number; boxes: Record<string, number>; allowableExpensesPence: number; netProfitPence: number; unmapped: string[] } {
  const chart = new Map(accounts.map((a) => [a.code, a]));
  const boxes: Record<string, number> = {};
  const unmapped: string[] = [];
  for (const e of pnl.expenses) {
    if (e.code === "9999") {
      unmapped.push(e.code);
      continue; // suspense is not claimable until reviewed
    }
    const box = chart.get(e.code)?.sa103 ?? "other";
    if (!chart.get(e.code)?.sa103) unmapped.push(e.code);
    boxes[box] = (boxes[box] ?? 0) + e.pence;
  }
  const allowable = Object.values(boxes).reduce((a, b) => a + b, 0);
  return { turnoverPence: pnl.totalIncomePence, boxes, allowableExpensesPence: allowable, netProfitPence: pnl.totalIncomePence - allowable, unmapped };
}
