/**
 * Import transactions from other bookkeeping tools' CSV exports (Xero, QuickBooks, FreshBooks) so switching is painless.
 * Header aliases are matched case-insensitively; the source category is kept so it can seed per-tenant rules.
 */
import { parseAmountToPence } from "@xevrion/pipeline";
import { readCsv, type ImportedLine } from "./importers.js";

export type AccountingSource = "xero" | "quickbooks" | "freshbooks" | "freeagent";
export interface AccountingLine extends ImportedLine {
  sourceCategory?: string;
}
const PROFILES: Record<
  AccountingSource,
  { date: string[]; desc: string[]; amount?: string[]; debit?: string[]; credit?: string[]; category: string[]; ref: string[] }
> = {
  xero: {
    date: ["date"],
    desc: ["description", "payee", "contact"],
    amount: ["amount", "net amount", "gross"],
    category: ["account", "account name", "account code"],
    ref: ["reference"],
  },
  quickbooks: {
    date: ["date", "transaction date"],
    desc: ["description", "memo/description", "name", "payee"],
    amount: ["amount"],
    debit: ["debit"],
    credit: ["credit"],
    category: ["account", "category", "split"],
    ref: ["num", "no.", "ref no."],
  },
  freeagent: {
    date: ["dated on", "date"],
    desc: ["description", "explanation"],
    amount: ["gross value", "amount"],
    category: ["category"],
    ref: ["bank transaction id", "reference"],
  },
  freshbooks: {
    date: ["date"],
    desc: ["description", "merchant", "vendor", "client"],
    amount: ["amount", "grand total", "total"],
    category: ["category"],
    ref: ["invoice number", "expense id"],
  },
};

export function detectAccountingSource(header: string[]): AccountingSource | null {
  const h = header.map((x) => x.trim().toLowerCase());
  if (h.includes("account code") || (h.includes("contact") && h.includes("reference"))) return "xero";
  if (h.includes("memo/description") || h.includes("split") || (h.includes("debit") && h.includes("credit") && h.includes("num"))) return "quickbooks";
  if (h.includes("dated on") || h.includes("gross value")) return "freeagent";
  if (h.includes("merchant") || h.includes("vendor") || h.includes("grand total")) return "freshbooks";
  return null;
}

const toIso = (s: string): string | null => {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) [d, mo, y] = [+m[1]!, +m[2]!, +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!];
  else if ((m = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/))) {
    const idx = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2]!.toLowerCase());
    if (idx < 0) return null;
    [d, mo, y] = [+m[1]!, idx + 1, +m[3]!];
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

export function parseAccountingExport(
  text: string,
  source?: AccountingSource,
): { source: AccountingSource; lines: AccountingLine[]; rejected: { row: number; error: string }[] } {
  const rows = readCsv(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("empty file");
  const header = rows[0]!.map((x) => x.trim().toLowerCase());
  const src = source ?? detectAccountingSource(header);
  if (!src) throw new Error("unrecognised export: expected a Xero, QuickBooks, FreeAgent or FreshBooks CSV");
  const p = PROFILES[src];
  const col = (names?: string[]) => (names ? (names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1) : -1);
  const [cDate, cDesc, cAmt, cDr, cCr, cCat, cRef] = [col(p.date), col(p.desc), col(p.amount), col(p.debit), col(p.credit), col(p.category), col(p.ref)];
  if (cDate < 0 || (cAmt < 0 && cDr < 0 && cCr < 0)) throw new Error(`missing required columns for ${src} (date and amount)`);
  const lines: AccountingLine[] = [];
  const rejected: { row: number; error: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    const date = toIso(r[cDate] ?? "");
    if (!date) return void rejected.push({ row, error: "invalid date" });
    let amountPence: number;
    try {
      if (cAmt >= 0 && (r[cAmt] ?? "").trim()) amountPence = parseAmountToPence(r[cAmt]!);
      else {
        const dr = (r[cDr] ?? "").trim() ? parseAmountToPence(r[cDr]!) : 0;
        const cr = (r[cCr] ?? "").trim() ? parseAmountToPence(r[cCr]!) : 0;
        if (!dr && !cr) throw new Error("no amount");
        amountPence = cr - dr;
      }
    } catch {
      return void rejected.push({ row, error: "invalid amount" });
    }
    const description = (r[cDesc] ?? "").trim() || "(no description)";
    const cat = (r[cCat] ?? "").trim();
    const ref = (r[cRef] ?? "").trim();
    lines.push({ date, description, amountPence, ...(cat ? { sourceCategory: cat } : {}), ...(ref ? { externalId: ref } : {}) });
  });
  return { source: src, lines, rejected };
}
