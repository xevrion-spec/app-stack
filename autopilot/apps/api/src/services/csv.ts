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
  if (q) throw new RangeError("CSV has an unterminated quoted field");
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

const validYmd = (y: number, m: number, d: number) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Normalise UK bank date renderings to ISO yyyy-mm-dd: yyyy-mm-dd (optionally with a time, e.g. Revolut),
 * dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy and "01 Jul 2026"/"01-Jul-26". UK banks are day-first. Rejects impossible dates.
 */
export function toIsoDate(raw: string): string {
  const t = raw.trim();
  let y: number, mo: number, d: number;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[3]!.length === 2) y += 2000;
  } else if ((m = t.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2}|\d{4})$/))) {
    [d, mo, y] = [Number(m[1]), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[3])];
    if (m[3]!.length === 2) y += 2000;
  } else throw new RangeError(`unrecognised date: ${raw}`);
  if (!validYmd(y, mo, d)) throw new RangeError(`invalid date: ${raw}`);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Accepts headers: date + description + (amount | paid out/paid in | debit/credit) [+ currency]. */
export function parseBankCsv(text: string, maxRows = 5000): { lines: ParsedBankLine[]; rejected: { row: number; error: string }[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new RangeError("CSV needs a header row and at least one data row");
  if (rows.length - 1 > maxRows) throw new RangeError(`CSV has more than ${maxRows} rows`);
  const h = rows[0]!.map((x) => x.trim().toLowerCase());
  const idx = (...names: string[]) => {
    for (const n of names) {
      const exact = h.indexOf(n);
      if (exact >= 0) return exact;
    }
    return h.findIndex((x) => names.some((n) => x.includes(n)));
  };
  // Prefer the posting/completed date over value/started dates when a bank exports several.
  const iDate = idx("date", "transaction date", "posting date", "completed date", "posted");
  const iDesc = idx("description", "transaction description", "details", "narrative", "memo", "payee", "counter party", "name", "reference");
  const iAmt = h.findIndex((x) => x === "amount" || x === "value" || /^amount\s*\(gbp\)$/.test(x) || x === "amount gbp");
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
      // A shifted row (e.g. an unquoted "12,34") must not be silently read from the wrong columns.
      if (r.slice(h.length).some((f) => f.trim() !== "")) throw new RangeError(`row has ${r.length} columns, header has ${h.length}`);
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
