/**
 * V4 provider interfaces with deterministic adapters (ADR 0017):
 *  - DocumentExtractor: receipt/invoice field extraction. `TextReceiptExtractor` is real, deterministic logic over OCR'd or
 *    PDF text; an LLM-vision adapter can implement the same interface later. `MockExtractor` returns fixed synthetic data.
 *  - MtdGateway: HMRC MTD ITSA obligations + quarterly updates. ONLY `MockMtdGateway` exists; nothing talks to HMRC.
 *  - BankFeed: Open Banking-style accounts + transactions. ONLY `MockBankFeed` exists (synthetic data).
 */
import { addDays } from "./text.js";

// ---------- extraction ----------
export interface Extraction {
  vendor: string | null;
  date: string | null;
  totalPence: number | null;
  vatPence: number | null;
  currency: string;
  invoiceNumber: string | null;
  confidence: number; // 0..1 overall
  fields: Record<string, number>; // per-field confidence
  needsReview: boolean;
}
export interface DocumentExtractor {
  readonly name: string;
  extract(input: { text: string; contentType?: string }): Promise<Extraction>;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const toPence = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
function findDate(t: string): string | null {
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const uk = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  const long = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [+iso[1]!, +iso[2]!, +iso[3]!];
  else if (uk) [d, m, y] = [+uk[1]!, +uk[2]!, +uk[3]! < 100 ? 2000 + +uk[3]! : +uk[3]!];
  else if (long) [d, m, y] = [+long[1]!, MONTHS.indexOf(long[2]!.toLowerCase()) + 1, +long[3]!];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}
const AMT = String.raw`(?:£|GBP\s*|€|EUR\s*|\$|USD\s*)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})`;
function lastAmountAfter(t: string, labels: string): number | null {
  const re = new RegExp(String.raw`\b(?:${labels})\b(?:\s*@?\s*\d{1,2}(?:\.\d+)?\s*%)?[^\d£€$\n]{0,20}${AMT}`, "gi");
  let m: RegExpExecArray | null,
    last: string | null = null;
  while ((m = re.exec(t))) last = m[1]!;
  return last === null ? null : toPence(last);
}
export class TextReceiptExtractor implements DocumentExtractor {
  readonly name = "text-rules";
  async extract({ text }: { text: string }): Promise<Extraction> {
    const t = text.replace(/\r/g, "");
    const total = lastAmountAfter(t, "grand total|total due|amount due|balance due|total");
    const vat = lastAmountAfter(t, "vat|tax");
    const date = findDate(t);
    const currency = /€|\bEUR\b/.test(t) ? "EUR" : /\$|\bUSD\b/.test(t) ? "USD" : "GBP";
    const vendor =
      t
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /[A-Za-z]{3}/.test(l) && !/receipt|invoice|tax|vat|date|total/i.test(l))
        ?.slice(0, 80) ?? null;
    const inv = t.match(/\b(?:invoice|inv|receipt)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{3,20})\b/i)?.[1] ?? null;
    const fields: Record<string, number> = { total: total !== null ? 0.9 : 0, date: date ? 0.85 : 0, vendor: vendor ? 0.6 : 0, vat: vat !== null ? 0.8 : 0.3 };
    const sane = total !== null && (vat === null || vat <= total);
    if (!sane) fields.vat = 0;
    const confidence = Math.round(((fields.total! * 2 + fields.date! + fields.vendor! + fields.vat!) / 5) * 100) / 100;
    return {
      vendor,
      date,
      totalPence: total,
      vatPence: sane ? vat : null,
      currency,
      invoiceNumber: inv,
      confidence,
      fields,
      needsReview: confidence < 0.75 || total === null,
    };
  }
}
export class MockExtractor implements DocumentExtractor {
  readonly name = "mock";
  async extract(): Promise<Extraction> {
    return {
      vendor: "Synthetic Supplies Ltd",
      date: "2026-07-01",
      totalPence: 1200,
      vatPence: 200,
      currency: "GBP",
      invoiceNumber: "MOCK-1",
      confidence: 1,
      fields: { total: 1, date: 1, vendor: 1, vat: 1 },
      needsReview: false,
    };
  }
}

// ---------- MTD (mock only) ----------
export interface MtdObligation {
  periodKey: string;
  start: string;
  end: string;
  due: string;
  status: "open" | "fulfilled";
}
export interface QuarterlyUpdate {
  periodKey: string;
  turnoverPence: number;
  otherIncomePence: number;
  expenses: Record<string, number>;
}
export interface MtdReceipt {
  submissionId: string;
  periodKey: string;
  receivedAt: string;
  sandbox: true;
}
export interface MtdGateway {
  readonly name: string;
  obligations(taxYear: string): Promise<MtdObligation[]>;
  submitQuarterlyUpdate(u: QuarterlyUpdate): Promise<MtdReceipt>;
}
export class MtdValidationError extends Error {}
export class MockMtdGateway implements MtdGateway {
  readonly name = "mock-hmrc";
  private submitted = new Map<string, MtdReceipt>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async obligations(taxYear: string): Promise<MtdObligation[]> {
    const y = Number(taxYear.slice(0, 4));
    if (!/^\d{4}-\d{2}$/.test(taxYear)) throw new MtdValidationError("taxYear must look like 2026-27");
    const ends = [`${y}-07-05`, `${y}-10-05`, `${y + 1}-01-05`, `${y + 1}-04-05`];
    let start = `${y}-04-06`;
    return ends.map((end, i) => {
      const key = `${taxYear}-Q${i + 1}`;
      const o: MtdObligation = { periodKey: key, start, end, due: addDays(end, 37), status: this.submitted.has(key) ? "fulfilled" : "open" };
      start = addDays(end, 1);
      return o;
    });
  }
  async submitQuarterlyUpdate(u: QuarterlyUpdate): Promise<MtdReceipt> {
    if (!/^\d{4}-\d{2}-Q[1-4]$/.test(u.periodKey)) throw new MtdValidationError("unknown periodKey");
    if (this.submitted.has(u.periodKey)) throw new MtdValidationError("period already submitted");
    for (const [k, v] of Object.entries({ turnoverPence: u.turnoverPence, otherIncomePence: u.otherIncomePence, ...u.expenses }))
      if (!Number.isInteger(v) || v < 0) throw new MtdValidationError(`${k} must be a non-negative integer`);
    const r: MtdReceipt = {
      submissionId: `mock-${u.periodKey}-${this.submitted.size + 1}`,
      periodKey: u.periodKey,
      receivedAt: this.clock().toISOString(),
      sandbox: true,
    };
    this.submitted.set(u.periodKey, r);
    return r;
  }
}

// ---------- bank feed (mock only) ----------
export interface FeedAccount {
  id: string;
  name: string;
  currency: string;
}
export interface FeedTransaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amountPence: number;
}
export interface BankFeed {
  readonly name: string;
  accounts(): Promise<FeedAccount[]>;
  transactions(accountId: string, since: string, until: string): Promise<FeedTransaction[]>;
}
export class MockBankFeed implements BankFeed {
  readonly name = "mock-openbanking";
  async accounts(): Promise<FeedAccount[]> {
    return [{ id: "mock-acc-1", name: "Synthetic Business Current", currency: "GBP" }];
  }
  async transactions(accountId: string, since: string, until: string): Promise<FeedTransaction[]> {
    if (accountId !== "mock-acc-1") throw new RangeError("unknown account");
    const out: FeedTransaction[] = [];
    const seq = ["SYNTHETIC CLIENT PAYMENT", "SYNTHETIC SOFTWARE SUB", "SYNTHETIC FUEL"];
    const amt = [150000, -1999, -4500];
    for (let d = since, i = 0; d <= until && out.length < 500; d = addDays(d, 3), i++)
      out.push({ id: `mock-${d}-${i % 3}`, accountId, date: d, description: seq[i % 3]!, amountPence: amt[i % 3]! });
    return out;
  }
}

/** Build an MTD quarterly update from a P&L-style summary (SA103 boxes). Figures are the user's books; the mapping is UNVERIFIED. */
export function buildQuarterlyUpdate(periodKey: string, turnoverPence: number, boxes: Record<string, number>, otherIncomePence = 0): QuarterlyUpdate {
  const expenses: Record<string, number> = {};
  for (const [k, v] of Object.entries(boxes)) if (v > 0) expenses[k] = v;
  return { periodKey, turnoverPence: Math.max(0, turnoverPence), otherIncomePence: Math.max(0, otherIncomePence), expenses };
}
