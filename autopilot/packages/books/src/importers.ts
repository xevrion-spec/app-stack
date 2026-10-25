/**
 * Bank statement importers beyond CSV: OFX (1.x SGML and 2.x XML), QIF and SWIFT MT940, plus format auto-detection.
 * All return the same shape so the upload pipeline treats every format identically. Amounts are integer pence.
 */
import { parseAmountToPence, type Pence } from "@xevrion/pipeline";

export type StatementFormat = "ofx" | "qif" | "mt940" | "csv";
export interface ImportedLine {
  date: string; // YYYY-MM-DD
  description: string;
  amountPence: Pence;
  externalId?: string; // FITID / bank reference, used for exact de-duplication
  counterparty?: string;
}
export interface ImportResult {
  format: StatementFormat;
  lines: ImportedLine[];
  rejected: { row: number; error: string }[];
  account?: { id?: string; currency?: string };
}

export function detectFormat(text: string): StatementFormat {
  const head = text.slice(0, 2000).trimStart();
  if (/^OFXHEADER:|<OFX>|<\?OFX/i.test(head) || /<STMTTRN>/i.test(head)) return "ofx";
  if (/^!Type:/i.test(head)) return "qif";
  if (/(^|\n):20:/.test(head) && /(^|\n):61:/.test(text)) return "mt940";
  return "csv";
}

const iso = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const clean = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** OFX: tags may be unclosed (SGML 1.x) or closed (XML 2.x). */
export function parseOfx(text: string): ImportResult {
  const lines: ImportedLine[] = [];
  const rejected: ImportResult["rejected"] = [];
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"))?.[1]?.trim();
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  blocks.forEach((raw, i) => {
    const block = raw.split(/<\/STMTTRN>/i)[0]!;
    const d = tag(block, "DTPOSTED");
    const amt = tag(block, "TRNAMT");
    const m = d?.match(/^(\d{4})(\d{2})(\d{2})/);
    const date = m ? iso(+m[1]!, +m[2]!, +m[3]!) : null;
    if (!date) return void rejected.push({ row: i + 1, error: "invalid or missing DTPOSTED" });
    let amountPence: number;
    try {
      amountPence = parseAmountToPence(amt ?? "");
    } catch {
      return void rejected.push({ row: i + 1, error: "invalid TRNAMT" });
    }
    const name = clean(tag(block, "NAME") ?? "");
    const memo = clean(tag(block, "MEMO") ?? "");
    const description = [name, memo].filter(Boolean).join(" ") || "(no description)";
    const fitid = tag(block, "FITID");
    lines.push({ date, description, amountPence, ...(fitid ? { externalId: fitid } : {}), ...(name ? { counterparty: name } : {}) });
  });
  const acct = tag(text, "ACCTID");
  const cur = tag(text, "CURDEF");
  return { format: "ofx", lines, rejected, account: { ...(acct ? { id: acct } : {}), ...(cur ? { currency: cur } : {}) } };
}

/** QIF dates are ambiguous (D/M/Y in the UK, M/D/Y in the US). UK order by default; `'` separates 2-digit years (e.g. 1/7'26). */
export function parseQif(text: string, opts: { dayFirst?: boolean } = {}): ImportResult {
  const dayFirst = opts.dayFirst ?? true;
  const lines: ImportedLine[] = [];
  const rejected: ImportResult["rejected"] = [];
  const records = text.replace(/\r/g, "").split(/\n\^\s*(?:\n|$)/);
  let row = 0;
  for (const rec of records) {
    const fields = rec.split("\n").filter((l) => l && !l.startsWith("!"));
    if (!fields.length) continue;
    row++;
    const f = (c: string) =>
      fields
        .find((l) => l[0] === c)
        ?.slice(1)
        .trim();
    const dm = f("D")?.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-]|')\s*(\d{2,4})$/);
    let date: string | null = null;
    if (dm) {
      const a = +dm[1]!,
        b = +dm[2]!;
      let y = +dm[3]!;
      if (y < 100) y += 2000;
      date = dayFirst ? iso(y, b, a) : iso(y, a, b);
    }
    if (!date) {
      rejected.push({ row, error: "invalid or missing D (date)" });
      continue;
    }
    let amountPence: number;
    try {
      amountPence = parseAmountToPence(f("T") ?? f("U") ?? "");
    } catch {
      rejected.push({ row, error: "invalid T (amount)" });
      continue;
    }
    const payee = clean(f("P") ?? "");
    const memo = clean(f("M") ?? "");
    const ref = f("N");
    lines.push({
      date,
      description: [payee, memo].filter(Boolean).join(" ") || "(no description)",
      amountPence,
      ...(ref ? { externalId: ref } : {}),
      ...(payee ? { counterparty: payee } : {}),
    });
  }
  return { format: "qif", lines, rejected };
}

/** SWIFT MT940: :61: statement lines (YYMMDD[MMDD]C|D|RC|RD amount ...) followed by optional :86: narrative. */
export function parseMt940(text: string): ImportResult {
  const lines: ImportedLine[] = [];
  const rejected: ImportResult["rejected"] = [];
  const t = text.replace(/\r/g, "");
  const cur = t.match(/:60[FM]:[CD]\d{6}([A-Z]{3})/)?.[1];
  const acct = t.match(/:25:([^\n]+)/)?.[1]?.trim();
  const parts = t.split(/\n(?=:61:)/).slice(1);
  parts.forEach((p, i) => {
    const [first, ...rest] = p.split("\n");
    const m = first!.match(/^:61:(\d{2})(\d{2})(\d{2})(?:\d{4})?(R?[CD])[A-Z]?(\d+,\d{0,2})N?[A-Z0-9]{0,3}([^/\n]*)(?:\/\/(.*))?/);
    if (!m) return void rejected.push({ row: i + 1, error: "unrecognised :61: line" });
    const date = iso(2000 + +m[1]!, +m[2]!, +m[3]!);
    if (!date) return void rejected.push({ row: i + 1, error: "invalid value date" });
    const mark = m[4]!;
    const [whole, frac = ""] = m[5]!.split(",");
    const pence = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
    const credit = mark === "C" || mark === "RD"; // RD (reversal of debit) increases the balance
    const narrative = rest
      .join("\n")
      .split(/\n(?=:\d{2}[A-Z]?:)/)
      .find((x) => x.startsWith(":86:"))
      ?.slice(4)
      .replace(/\n/g, " ");
    const description = clean(narrative ?? "") || clean(m[6] ?? "") || "(no description)";
    const ref = clean(m[6] ?? "");
    lines.push({ date, description, amountPence: credit ? pence : -pence, ...(ref && ref !== "NONREF" ? { externalId: ref } : {}) });
  });
  return { format: "mt940", lines, rejected, account: { ...(acct ? { id: acct } : {}), ...(cur ? { currency: cur } : {}) } };
}

/** Minimal RFC-4180 CSV reader (quoted fields, escaped quotes, CRLF). Throws on an unterminated quote. */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (q) throw new Error("unterminated quoted field");
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}
