import type { Pence } from "./money.js";
import { assertPence } from "./money.js";

export const ACCOUNTS = { BANK: "1200", SAVINGS: "1210", VAT_CONTROL: "2200", SUSPENSE: "9999" } as const;

export interface JournalLine {
  accountCode: string;
  debitPence: Pence;
  creditPence: Pence;
  vatRateCode?: string | null;
}
export interface Journal {
  entryDate: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  lines: JournalLine[];
}

export class LedgerInvariantError extends Error {}

/** A journal is valid iff it has >=2 lines, each line is one-sided and non-negative, and debits == credits. */
export function validateJournal(j: Journal): void {
  if (j.lines.length < 2) throw new LedgerInvariantError("journal needs at least two lines");
  let dr = 0,
    cr = 0;
  for (const l of j.lines) {
    assertPence(l.debitPence, "debit");
    assertPence(l.creditPence, "credit");
    if (l.debitPence < 0 || l.creditPence < 0) throw new LedgerInvariantError("negative amounts are not allowed");
    if (l.debitPence > 0 && l.creditPence > 0) throw new LedgerInvariantError("a line cannot be both debit and credit");
    dr += l.debitPence;
    cr += l.creditPence;
  }
  if (dr !== cr) throw new LedgerInvariantError(`unbalanced journal: debits ${dr} != credits ${cr}`);
  if (dr === 0) throw new LedgerInvariantError("empty journal");
}

/** Build the double-entry journal for one categorised bank line (gross split into net + VAT). */
export function journalForBankLine(p: {
  id: string;
  date: string;
  description: string;
  grossPence: Pence;
  categoryCode: string;
  kind: "income" | "expense" | "transfer" | "suspense" | "capital";
  vatPence: Pence;
  vatRateCode?: string | null;
}): Journal {
  assertPence(p.grossPence, "gross");
  const g = Math.abs(p.grossPence);
  const vat = Math.min(Math.abs(p.vatPence), g);
  const net = g - vat;
  const lines: JournalLine[] = [];
  const counter = p.kind === "transfer" ? ACCOUNTS.SAVINGS : p.categoryCode;
  if (p.grossPence >= 0) {
    lines.push({ accountCode: ACCOUNTS.BANK, debitPence: g, creditPence: 0 });
    lines.push({ accountCode: counter, debitPence: 0, creditPence: p.kind === "transfer" ? g : net, vatRateCode: p.vatRateCode ?? null });
    if (p.kind !== "transfer" && vat > 0) lines.push({ accountCode: ACCOUNTS.VAT_CONTROL, debitPence: 0, creditPence: vat });
  } else {
    lines.push({ accountCode: counter, debitPence: p.kind === "transfer" ? g : net, creditPence: 0, vatRateCode: p.vatRateCode ?? null });
    if (p.kind !== "transfer" && vat > 0) lines.push({ accountCode: ACCOUNTS.VAT_CONTROL, debitPence: vat, creditPence: 0 });
    lines.push({ accountCode: ACCOUNTS.BANK, debitPence: 0, creditPence: g });
  }
  const j: Journal = {
    entryDate: p.date,
    memo: p.description,
    sourceType: "transaction",
    sourceId: p.id,
    lines: lines.filter((l) => l.debitPence || l.creditPence),
  };
  validateJournal(j);
  return j;
}

/** Trial balance: per-account net (debit - credit). Sum over all accounts is always 0 for valid journals. */
export function trialBalance(journals: Journal[]): Map<string, Pence> {
  const tb = new Map<string, Pence>();
  for (const j of journals) for (const l of j.lines) tb.set(l.accountCode, (tb.get(l.accountCode) ?? 0) + l.debitPence - l.creditPence);
  return tb;
}
