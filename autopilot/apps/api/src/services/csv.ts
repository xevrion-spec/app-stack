import { parseAmountToPence } from "@xevrion/pipeline";

/** RFC4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    q = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface ParsedBankLine {
  row: number;
  date: string;
  description: string;
  amountPence: number;
  currency: string;
}

/** Normalise dd/mm/yyyy, yyyy-mm-dd, dd-mm-yyyy to ISO. UK banks use day-first. */
export function toIsoDate(raw: string): string {
  const t = raw.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    const iso = `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  throw new RangeError(`unrecognised date: ${raw}`);
}

/** Accepts headers: date + description + (amount | paid out/paid in | debit/credit) [+ currency]. */
export function parseBankCsv(text: string, maxRows = 5000): { lines: ParsedBankLine[]; rejected: { row: number; error: string }[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new RangeError("CSV needs a header row and at least one data row");
  if (rows.length - 1 > maxRows) throw new RangeError(`CSV has more than ${maxRows} rows`);
  const h = rows[0]!.map((x) => x.trim().toLowerCase());
  const idx = (...names: string[]) => h.findIndex((x) => names.some((n) => x === n || x.includes(n)));
  const iDate = idx("date"),
    iDesc = idx("description", "details", "narrative", "memo", "payee");
  const iAmt = h.findIndex((x) => x === "amount" || x === "value");
  const iOut = idx("paid out", "debit", "money out"),
    iIn = idx("paid in", "credit", "money in"),
    iCur = idx("currency");
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iOut < 0 || iIn < 0)))
    throw new RangeError("CSV must have date, description and amount (or paid in/paid out) columns");
  const lines: ParsedBankLine[] = [],
    rejected: { row: number; error: string }[] = [];
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    try {
      const date = toIsoDate(r[iDate] ?? "");
      const description = (r[iDesc] ?? "").trim().slice(0, 300);
      if (!description) throw new RangeError("empty description");
      let amountPence: number;
      if (iAmt >= 0) amountPence = parseAmountToPence(r[iAmt] ?? "");
      else {
        const out = (r[iOut] ?? "").trim(),
          inn = (r[iIn] ?? "").trim();
        amountPence = (inn ? parseAmountToPence(inn) : 0) - (out ? Math.abs(parseAmountToPence(out)) : 0);
      }
      const currency = ((iCur >= 0 ? r[iCur] : "") || "GBP").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`bad currency ${currency}`);
      lines.push({ row: rowNo, date, description, amountPence, currency });
    } catch (e) {
      rejected.push({ row: rowNo, error: (e as Error).message });
    }
  });
  return { lines, rejected };
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
